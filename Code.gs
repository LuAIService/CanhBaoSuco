/**
 * Báo sự cố SPM – backend (Google Apps Script Web App)
 *
 * Script Properties cần thiết (Project Settings > Script Properties):
 *   GEMINI_KEY, CLIENT_ID, RECIPIENTS, ALLOWED_EMAILS, FOLDER_ID
 * Không đặt key/ID thật trong file này.
 */
const MODEL = 'gemini-3.6-flash'; // kiểm tra model còn dùng free trong AI Studio, sai thì đổi tên
const TZ = 'Asia/Ho_Chi_Minh';
const MAX_B64_LEN = 14e6; // ~10 MB video
const P = () => PropertiesService.getScriptProperties();

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const user = verifyToken_(body.idToken);
    const allowed = P().getProperty('ALLOWED_EMAILS').toLowerCase().split(',').map(s => s.trim());
    if (!allowed.includes(user.email.toLowerCase())) throw new Error('Tài khoản chưa được phép: ' + user.email);
    if (!body.videoB64 || body.videoB64.length > MAX_B64_LEN) throw new Error('Video trống hoặc quá lớn');

    const mime = String(body.mime || 'video/mp4').split(';')[0];
    const ext = mime.includes('webm') ? 'webm' : 'mp4';
    const now = new Date();
    const when = Utilities.formatDate(now, TZ, 'HH:mm dd/MM/yyyy');
    const stamp = Utilities.formatDate(now, TZ, 'yyyyMMdd_HHmmss');

    const blob = Utilities.newBlob(Utilities.base64Decode(body.videoB64), mime, `${stamp}_${user.email}.${ext}`);
    const file = DriveApp.getFolderById(P().getProperty('FOLDER_ID')).createFile(blob);
    const to = P().getProperty('RECIPIENTS').split(',').map(s => s.trim()).filter(Boolean);
    try { file.addViewers(to); } catch (err) {} // cho người nhận xem được video

    let r;
    try { r = analyze_(body.videoB64, mime); }
    catch (err) { // AI lỗi (hết hạn mức...) vẫn gửi mail kèm video
      r = { dia_diem: 'Không rõ', loai_su_co: 'Chưa phân loại', noi_dung: 'AI lỗi: ' + err.message, loi_noi: '' };
    }

    sendMail_(to, when, user, r, file.getUrl());
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    ensureHeader_(sheet);
    // Cột A–G giữ nguyên thứ tự cũ; cột H (mới) = lời nói gốc. Ô Sheet tối đa 50.000 ký tự nên cắt bớt.
    sheet.appendRow([when, user.name, user.email, r.dia_diem, r.loai_su_co, r.noi_dung, file.getUrl(),
                     String(r.loi_noi || '').slice(0, 40000)]);
    return out_({ ok: true });
  } catch (err) {
    return out_({ ok: false, error: String(err.message || err) });
  }
}

function verifyToken_(t) {
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(t),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Đăng nhập không hợp lệ hoặc hết hạn');
  const j = JSON.parse(res.getContentText());
  if (j.aud !== P().getProperty('CLIENT_ID') || String(j.email_verified) !== 'true') throw new Error('Token sai');
  return { email: j.email, name: j.name || j.email };
}

function analyze_(b64, mime) {
  const prompt =
    'Bạn tiếp nhận báo sự cố cho tòa nhà cho thuê. Nghe lời nói tiếng Việt trong video và xem hình ảnh. ' +
    'Chỉ dựa vào những gì nghe/thấy, không suy đoán; thông tin không có thì ghi "Không rõ". ' +
    'Trả về: dia_diem (tầng/khu/phòng người nói nhắc tới); ' +
    'loai_su_co (chọn 1: Điện, Nước/Cấp thoát nước, Điều hòa/Thông gió, Thang máy, PCCC, An ninh, Vệ sinh, Kết cấu/Xây dựng, "Khác: <mô tả ngắn>"); ' +
    'noi_dung (tóm tắt 1-3 câu); loi_noi (chép lại lời nói).';
  const payload = {
    contents: [{ parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { dia_diem: { type: 'STRING' }, loai_su_co: { type: 'STRING' },
                      noi_dung: { type: 'STRING' }, loi_noi: { type: 'STRING' } },
        required: ['dia_diem', 'loai_su_co', 'noi_dung', 'loi_noi']
      }
    }
  };
  const res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent',
    { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': P().getProperty('GEMINI_KEY') },
      payload: JSON.stringify(payload), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Gemini ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  return JSON.parse(JSON.parse(res.getContentText()).candidates[0].content.parts[0].text);
}

function sendMail_(to, when, user, r, url) {
  const esc = s => String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const row = (k, v) => `<tr><td style="padding:6px 10px;border:1px solid #ccc"><b>${k}</b></td><td style="padding:6px 10px;border:1px solid #ccc">${v}</td></tr>`;
  const html = '<table style="border-collapse:collapse;font-family:Arial">' +
    row('Thời điểm', esc(when)) +
    row('Ai báo', esc(user.name) + ' (' + esc(user.email) + ')') +
    row('Địa điểm', esc(r.dia_diem)) +
    row('Loại sự cố', esc(r.loai_su_co)) +
    row('Nội dung', esc(r.noi_dung) + '<br><i>Lời nói gốc: ' + esc(r.loi_noi) + '</i>') +
    row('Video', '<a href="' + url + '">Xem video</a>') + '</table>' +
    '<p style="color:#888">AI tự tóm tắt từ video, việc quan trọng cần xem lại video.</p>';
  MailApp.sendEmail({ to: to.join(','), subject: '[Sự cố SPM] ' + r.loai_su_co + ' – ' + r.dia_diem, htmlBody: html });
}

// Chỉ tạo hàng tiêu đề khi Sheet còn trống hoàn toàn; Sheet đã có dữ liệu thì không đụng vào.
function ensureHeader_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Thời điểm', 'Ai báo', 'Email', 'Địa điểm', 'Loại sự cố', 'Nội dung', 'Video', 'Lời nói gốc']);
    sheet.setFrozenRows(1);
  }
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Chạy tay 1 lần để cấp quyền; log ra số email còn được gửi hôm nay
function authorize_() {
  Logger.log('Quota mail còn lại: ' + MailApp.getRemainingDailyQuota());
  DriveApp.getRootFolder();
  SpreadsheetApp.getActiveSpreadsheet();
  UrlFetchApp.fetch('https://example.com');
}
