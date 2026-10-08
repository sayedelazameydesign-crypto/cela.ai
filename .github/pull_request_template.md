## الوصف

إضافة بوابة تكاملات موحدة في `/integrations` تربط **GitHub** و**Vercel** و**Render** و**Google Drive** من باب حراسة واحد (`/api/owner/*`) مع 8 بطاقات (قراءة + كتابة لكل منصة).

## المكونات

- `backend/integrations/`: `config.py`, `redact.py`, `http.py`, `github.py`, `vercel.py`, `render.py`, `drive.py`, `service.py`
- واجهة البوابة: `backend/static/integrations.html`, `integrations.js`, `integrations-ui.js`, `integrations.css`
- أدوات الفحص والتشخيص: `scripts/deploy_doctor.py`, `scripts/integrations_live_check.py`, `.github/workflows/live-check.yml`
- التوثيق وقوالب النشر: `CREDENTIALS.md`, `DEPLOY-VERCEL.md`, `docs/integrations/*`, `.env.example`, `vercel.json`, `render.yaml`

## الأمان

- **Redaction تلقائي**: جميع الأخطاء والردود تمر عبر `redact.build_redactor(config.secrets())` لإخفاء الرموز وروابط Deploy Hook (بما فيها معلمة `?key=` الخاصة بـ Render).
- **منع SSRF وDNS Rebinding**: فحص HTTPS، قائمة نطاقات مسموحة، حلّ DNS مرة واحدة، رفض العناوين الداخلية، وتثبيت الـ IP على مقبس TLS.
- **فصل القراءة عن الكتابة**: رموز قراءة السجلات منفصلة عن روابط Deploy Hook، مع اشتراط عبارات تأكيد صريحة (`dispatch-ci`, `deploy`, `deploy-render`, `upload-drive`) وحدّ أقصى 3 عمليات كتابة في الدقيقة.
- **الفحص الحيّ آمن افتراضيًا**: يعمل بوضع القراءة فقط (`SKIP` للعمليات الأربع الكاتبة ما لم يُمرَّر `--allow-mutations` يدويًا).

## الاختبارات

- [x] `python3 -m unittest discover -s tests -p "test_*.py"` (492 اختبار Python ناجح)
- [x] `python3 scripts/integrations_live_check.py --self-test` (43 فحصًا ذاتيًا للمدقق الحيّ)
- [x] `python3 scripts/deploy_doctor.py --self-test` (فحص `deploy_doctor` الذاتي)
- [x] `node tests/browser_integrations.test.mjs` (22 فحص عقد متصفح لبوابة التكاملات)
