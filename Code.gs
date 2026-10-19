/**
 * Báo sự cố SPM – backend (Google Apps Script Web App)
 *
 * Script Properties cần thiết (Project Settings > Script Properties):
 *   GEMINI_KEY, CLIENT_ID, RECIPIENTS, ALLOWED_EMAILS, FOLDER_ID
 *   BASE_WEBHOOK_URL (tùy chọn): đường dẫn Incoming webhook của nhóm chat Base Message
 * Không đặt key/ID/URL webhook thật trong file này.
 *
 * Mở địa chỉ /exec trong trình duyệt để xem VERSION đang chạy (biết đã deploy bản mới chưa).
 */
const VERSION = '2026-10-19.4-cotI-base-status';
const MODEL = 'gemini-3.6-flash'; // kiểm tra model còn dùng free trong AI Studio, sai thì đổi tên
const TZ = 'Asia/Ho_Chi_Minh';
const MAX_B64_LEN = 14e6; // ~10 MB video
const P = () => PropertiesService.getScriptProperties();

// GET (mở /exec trên trình duyệt): chỉ trả về phiên bản đang chạy, không lộ dữ liệu nào.
function doGet() {
  return out_({ ok: true, version: VERSION });
}

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

    // Báo về nhóm chat Base Message. notifyBase_ không ném lỗi, chỉ trả về chuỗi trạng thái để ghi vào cột I.
    const baseStatus = notifyBase_(when, user, r, file.getUrl());

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    ensureHeader_(sheet);
    // Cột A–G giữ nguyên thứ tự cũ; H = lời nói gốc (ô Sheet tối đa 50.000 ký tự nên cắt bớt); I = kết quả báo Base.
    sheet.appendRow([when, user.name, user.email, r.dia_diem, r.loai_su_co, r.noi_dung, file.getUrl(),
                     String(r.loi_noi || '').slice(0, 40000), baseStatus]);
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
  // Gemini thỉnh thoảng báo 503 (quá tải) hoặc 429 (hết hạn mức): thử lại tối đa 3 lần, nghỉ 2s, 4s.
  let res, code;
  for (let i = 0; i < 3; i++) {
    res = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent',
      { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': P().getProperty('GEMINI_KEY') },
        payload: JSON.stringify(payload), muteHttpExceptions: true });
    code = res.getResponseCode();
    if (code !== 503 && code !== 429 && code !== 500) break;
    if (i < 2) Utilities.sleep(2000 * (i + 1));
  }
  if (code !== 200) {
    const busy = (code === 503 || code === 429 || code === 500);
    throw new Error('Gemini ' + code + (busy ? ' (quá tải hoặc hết hạn mức, đã thử lại 3 lần)' : ': ' + res.getContentText().slice(0, 200)));
  }
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

// Gửi tin vào nhóm chat Base Message qua "Incoming webhook integration" của nhóm.
// Trả về chuỗi trạng thái ("OK 200", "Lỗi 400: ...", "Chưa cấu hình BASE_WEBHOOK_URL") và KHÔNG ném lỗi,
// để lỗi Base không làm hỏng email và Sheet. Trạng thái được ghi vào cột I của Sheet để dễ kiểm tra.
// Tài liệu Base chưa nêu rõ định dạng gọi trực tiếp, nên payload chứa nhiều tên trường phổ biến
// (base_content/bot_name theo tài liệu Workflow -> Message, text/content theo kiểu webhook thông dụng).
// Thấy lỗi ở cột I thì chỉnh payload tại đây.
function notifyBase_(when, user, r, url) {
  const hook = P().getProperty('BASE_WEBHOOK_URL');
  try {
    if (!hook) {
      console.warn('Chưa cấu hình BASE_WEBHOOK_URL trong Script Properties');
      return 'Chưa cấu hình BASE_WEBHOOK_URL';
    }
    const text = buildBaseText_(when, user, r, url);
    const res = UrlFetchApp.fetch(hook, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({
        bot_name: 'Báo sự cố SPM', bot_username: 'bao_su_co_spm',
        base_content: text, text: text, content: text
      })
    });
    const code = res.getResponseCode();
    const body = res.getContentText().replace(/\s+/g, ' ').slice(0, 150);
    console.log('Base Message trả về ' + code + ': ' + body);
    return (code >= 200 && code < 300 ? 'OK ' : 'Lỗi ') + code + (body ? ': ' + body : '');
  } catch (err) {
    // Đường dẫn webhook coi như mật khẩu: che đi nếu thông báo lỗi của Apps Script có kèm theo.
    const msg = String(err.message).split(hook || '\u0000').join('[webhook]').slice(0, 150);
    console.error('Base Message lỗi: ' + msg);
    return 'Lỗi: ' + msg;
  }
}

function buildBaseText_(when, user, r, url) {
  return [
    '**🚨 SỰ CỐ MỚI – SPM**',
    '**Thời điểm:** ' + when,
    '**Ai báo:** ' + user.name + ' (' + user.email + ')',
    '**Địa điểm:** ' + r.dia_diem,
    '**Loại sự cố:** ' + r.loai_su_co,
    '**Nội dung:** ' + r.noi_dung,
    '**Video:** ' + url
  ].join('\n');
}

// Chạy tay trong trình soạn thảo để thử webhook (sẽ gửi 1 tin thử vào nhóm chat). Xem kết quả ở Execution log.
function testBase_() {
  const status = notifyBase_(Utilities.formatDate(new Date(), TZ, 'HH:mm dd/MM/yyyy'),
    { name: 'Tin thử', email: 'test@example.com' },
    { dia_diem: 'Thử nghiệm', loai_su_co: 'Thử nghiệm', noi_dung: 'Tin thử từ ứng dụng báo sự cố, bỏ qua tin này.' },
    'https://example.com');
  Logger.log('Kết quả: ' + status);
}

// Chỉ tạo hàng tiêu đề khi Sheet còn trống hoàn toàn; Sheet đã có dữ liệu thì không đụng vào.
function ensureHeader_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Thời điểm', 'Ai báo', 'Email', 'Địa điểm', 'Loại sự cố', 'Nội dung', 'Video', 'Lời nói gốc', 'Báo Base']);
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
