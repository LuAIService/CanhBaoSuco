# Báo sự cố SPM (CanhBaoSuco)

PWA báo sự cố bằng video cho tòa nhà cho thuê SPM. Người báo đăng nhập Google, bấm 1 nút, quay tối đa 60 giây.
Hệ thống lưu video lên Drive, nhờ Gemini nghe và phân tích, rồi gửi email cho nhiều người nhận theo format:
**Thời điểm · Ai báo · Địa điểm · Loại sự cố · Nội dung**. Toàn bộ dùng dịch vụ miễn phí của Google.

## Kiến trúc
- `index.html`, `manifest.json`, `sw.js`, `icon-*.png`: PWA tĩnh, host trên GitHub Pages (cần HTTPS).
- `Code.gs`: Google Apps Script Web App (backend): xác thực token, lưu Drive, gọi Gemini, gửi Gmail, ghi Sheet.
- Không chạy HTML trong Apps Script vì iframe của Apps Script thường chặn camera/micro (cần kiểm chứng).

## Cấu hình (Script Properties của Apps Script)
| Key | Ý nghĩa |
|---|---|
| `GEMINI_KEY` | API key từ Google AI Studio |
| `CLIENT_ID` | OAuth Client ID (Web) |
| `RECIPIENTS` | Email nhận, cách nhau bằng dấu phẩy |
| `ALLOWED_EMAILS` | Email được phép báo, cách nhau bằng dấu phẩy |
| `FOLDER_ID` | ID thư mục Drive chứa video |

Không commit key hay ID thật vào repo. `CLIENT_ID` và `API_URL` trong `index.html` không phải secret nhưng phải điền sau khi tạo.

## Dựng
1. Tạo Google Sheet, Extensions > Apps Script, dán `Code.gs`, chạy tay `authorize_` để cấp quyền.
2. Điền Script Properties như bảng trên.
3. Deploy > Web app: Execute as *Me*, access *Anyone*. Copy URL `/exec` vào `API_URL` trong `index.html`. Sửa code thì deploy "New version".
4. Google Cloud Console: tạo OAuth consent screen và Client ID loại Web, Authorized JavaScript origins = `https://<tên-github>.github.io`. Ở chế độ Testing, thêm từng email người báo vào Test users (tối đa 100).
5. Dán `CLIENT_ID` vào `index.html`, bật GitHub Pages cho repo (icon mẫu đã có sẵn, thay bằng logo SPM nếu muốn).
6. Android: Chrome, iPhone: Safari, chọn "Thêm vào màn hình chính".

## Rủi ro cần kiểm chứng
1. iPhone/Safari có thể bỏ qua bitrate, file nặng hơn dự kiến: đo dung lượng thật của 60s trên cả 2 loại máy.
2. Giới hạn kích thước POST của Apps Script chưa rõ: code đang chặn ở ~14 MB base64 (~10 MB video). Nếu bị từ chối sớm hơn, hạ bitrate hoặc đổi sang Google Form + Apps Script trigger.
3. Gmail cá nhân giới hạn số người nhận mỗi ngày (ước ~100): kiểm tra bằng `MailApp.getRemainingDailyQuota()` (hàm `authorize_` in ra).
4. Gemini free tier: hạn mức xem trong AI Studio; dữ liệu có thể bị Google dùng để cải thiện sản phẩm (video có người và khu vực tòa nhà).
5. Loại sự cố do AI quyết có thể không nhất quán: danh mục đã khống chế trong prompt, sửa theo thực tế SPM.
6. Token đăng nhập hết hạn sau khoảng 1 giờ: app yêu cầu đăng nhập lại.
7. Sự cố khẩn (cháy, người bị thương) vẫn phải gọi điện trực tiếp, app chỉ gửi email.

## Việc còn lại
- Test trên Android Chrome và iPhone Safari: quay 60s, đo dung lượng, đăng nhập hết hạn, mất mạng giữa chừng.
