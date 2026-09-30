# Start here

1. Read VALIDATION_REPORT.md for the actual success/failure counts.
2. Follow README.md to install, configure HTTPS and start the app.
3. Use Start photo capture → Take QR Photo → Confirm serial → Take Battery Photo.
4. Rotate if needed and drag around only the battery digits and %. Compare the result before saving.
5. Find the registered device for H1–H4 and post-aging; follow the available stage actions.

## Required real Android checks

Both photo buttons must open the native camera/picker and return successfully. Test cancellation, permission denial, same-file retry, portrait/landscape and EXIF rotation, guide mapping at image edges, blur/glare, network loss, ticket expiry, wrong QR and duplicate registration. Complete all stages on a backed-up test workbook and verify one device row. Resolve HTTPS warnings rather than bypassing them.

These physical checks cannot be performed remotely in the development container. Native camera software may retain its own photos.
