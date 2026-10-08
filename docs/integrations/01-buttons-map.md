# بوابة تكاملات المالك — خريطة الأزرار

صفحة واحدة على `/integrations` تلمّ أربعة تكاملات. كل تكامل له بطاقتان: **قراءة**
(لا تغيّر شيئًا) و**كتابة** (تغيّر الإنتاج أو تكتب ملفًا). المجموع: 8 بطاقات، باب
واحد للحماية (`/api/owner/*`).

## قاعدة العرض الصدقة

البطاقة لا تخضرّ أبدًا لأن الصفحة فُتحت. كل حالة تُقرأ من ردّ الخادم
(`GET /api/owner/integrations`)، وما لم يقله الخادم يُكتب «غير معروف» لا «جاهز» ولا
«غير مُهيّأ». السبب: بطاقة تكذب بـ«جاهز» تدفعك لضغط زر نشر سيفشل.

## الأزرار الثمانية

| التكامل | القراءة | الكتابة | نص تأكيد الكتابة |
|---|---|---|---|
| GitHub Actions | `GET /api/owner/integrations/github/runs` | `POST /api/owner/integrations/github/dispatch` | `dispatch-ci` |
| Vercel | `GET /api/owner/integrations/vercel/deployments` | `POST /api/owner/integrations/vercel/deploy-hook` | `deploy` |
| Render | `GET /api/owner/integrations/render/deploys` | `POST /api/owner/integrations/render/deploy-hook` | `deploy-render` |
| Google Drive | `GET /api/owner/integrations/drive/files` | `POST /api/owner/integrations/drive/upload` | `upload-drive` |

## الحراسة (لن ينفّذ أي زر قبلها)

1. جلسة موقّعة بـHMAC من `WAHA_OWNER_TOKEN` — 8 ساعات، تُحفظ في `sessionStorage`
   للتبويبة وحدها (لا `localStorage`).
2. `X-Waha-CSRF` مربوط بالجلسة نفسها.
3. قائمة CORS خاصة بالإدارة منفصلة عن `WAHA_ALLOWED_ORIGINS`: معاينة على Pages
   مسموح لها الدردشة لا تستطيع أن تنشر.
4. `TRUSTED_HOSTS` في Flask يرفض أي `Host` غير معروف (حماية DNS rebinding).
5. Deploy Hook للـ Vercel والـ Render: فحص HTTPS + نطاق المورد + حلّ DNS مرة واحدة +
   رفض أي عنوان داخلي + تثبيت الـIP على مقبس TLS.
6. `confirm` بالنص المطلوب في جسم الطلب، وإلا `409`.
7. حدّ 3 عمليات كتابة في الدقيقة لكل IP، و5 محاولات دخول في الساعة.
8. كل رسالة خطأ تمرّ بمُحمِّر مبني من `config.secrets()`، فلا يظهر مفتاح ولا رابط
   Hook حتى لو ردّ المورد بجسمه كاملًا.

## متى يُرفَض النداء بلا شبكة إطلاقًا؟

تكاملٌ ناقص يجيب `503 not_configured` مع أسماء المتغيرات الناقصة في `missing[]`.
الـclient لا يبني رابطًا ولا يلمس الشبكة قبل هذا الفحص — لهذا «نسيان متغير» لا يظهر
كـ«المورد معطّل» ولا كـ«مفتاح مرفوض».

## الملفات المعنية في المستودع

```
backend/integrations/config.py   بيئة -> كائنات مُهيّأة؛ لا تُسلسل سرًّا أبدًا
backend/integrations/redact.py   يُحمِّر كل ما يخرج من العملية
backend/integrations/http.py     Transport + قائمة النطاقات + حارس العناوين
backend/integrations/github.py   قراءات Actions + dispatch
backend/integrations/vercel.py   سجل النشرات + Deploy Hook
backend/integrations/render.py   سجل deploys + Deploy Hook   (جديد)
backend/integrations/drive.py    تعداد مجلد + رفع ملف نصي    (جديد)
backend/integrations/service.py  الدمج + الـstatus؛ الشيء الوحيد الذي تستدعيه app.py
backend/static/integrations.js   منطق البطاقات (بلا DOM، يُختبر في node)
backend/static/integrations-ui.jsالرسم + الاستدعاءات
tests/test_integrations_portal.pyطبقة 1+2 للتكامُلَين الجديدين (35 اختبارًا)
```
