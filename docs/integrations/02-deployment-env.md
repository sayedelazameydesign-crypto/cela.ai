# قائمة المتغيرات — ما يلزم لصلة كل حساب

الترتيب مقصود: ابدأ بالمتغيرات التي تجعل الصفحة تُفتح، ثم التكامل تكاملًا. كل اسم
يُقرأ من `backend/integrations/config.py::load()` ولا يُطبع أيّ منه في أي ردّ.

## 0) البوابة نفسها (بلا هذا لا تُفتح)

| المتغيّر | القيمة | ملاحظة |
|---|---|---|
| `WAHA_OWNER_TOKEN` | `openssl rand -hex 32` | يفتح `/api/owner/login`؛ لا يُرسل للمتصفح أبدًا |
| `WAHA_ALLOWED_ORIGINS` | نطاق الواجهة العام | لدردشة الزوّار |
| `WAHA_OWNER_ALLOWED_ORIGINS` | نطاق الإدارة فقط | قائمة منفصلة عن قائمة الزوّار |
| `WAHA_TRUSTED_HOSTS` | اسم المضيف بدون `https://` وبدون منفذ | يلزم لنطاق مخصّص؛ على Render/Vercel يكفي `RENDER_EXTERNAL_HOSTNAME`/`VERCEL_URL` |

## 1) GitHub

| المتغيّر | القيمة |
|---|---|
| `GITHUB_TOKEN` | PAT فيه `actions: read` + `actions: write` (للتشغيل) |
| `GITHUB_REPO` | `owner/name` |
| `GITHUB_WORKFLOW_ID` | مثل `ci.yml` — يلزم للكتابة فقط |

## 2) Vercel

| المتغيّر | القيمة |
|---|---|
| `VERCEL_TOKEN` | read scope فقط (للقراءة) |
| `VERCEL_PROJECT_ID` | `prj_…` من Project → Settings → Project ID |
| `VERCEL_TEAM_ID` | `team_…` — الـslug لا يعمل ويرفض بـ403 |
| `DEPLOY_HOOK_URL` | رابط الـHook؛ **الرابط نفسه هو سرّ النشر** |

ملاحظة من `DEPLOY-VERCEL.md`: المسار الآمن أن تعيش المفاتيح في GitHub Secrets
ويُنقلها `Sync production keys to Vercel` workflow إلى Vercel؛ هذا المجلد لا ينسخ
قيمة أي مفتاح.

## 3) Render

| المتغيّر | القيمة |
|---|---|
| `RENDER_API_KEY` | حساب Render → Settings → API Keys (للقراءة فقط) |
| `RENDER_SERVICE_ID` | `srv-…` من Service → Settings |
| `RENDER_DEPLOY_HOOK_URL` | Service → Settings → Deploy Hooks |

فرقٌ عن Vercel يستحق الانتباه: Render يضع سرّ الـHook في `?key=` داخل الـquery،
والـquery يُسجَّل في البروكسيات أسهل من الـpath. لهذا يُضاف الرابط كاملًا إلى
`config.secrets()` ولا يظهر في أي ردّ، ويُطبَع منه نصّ الرد فقط بعد التحمير.

## 4) Google Drive

طريقتان، والشكل يظهر في `describe()["drive"]["credential"]`:

| المتغيّر | الاستخدام |
|---|---|
| `GOOGLE_DRIVE_ACCESS_TOKEN` | **تجربة**: رمز قصير العمر (ساعة). لا يُجدَّد ولا يُخزَّن |
| `GOOGLE_DRIVE_REFRESH_TOKEN` + `GOOGLE_DRIVE_CLIENT_ID` + `GOOGLE_DRIVE_CLIENT_SECRET` | **دائم**: الخادم يصنع رمز وصول عند الحاجة ويكيّفه 60 ثانية قبل انتهائه |
| `GOOGLE_DRIVE_FOLDER_ID` | اختياري: مجلد واحد يصبح هو الافتراضي للرفع والتعداد |

نصفُ ثلاثيّ ليس إعدادًا ناقصًا بل هو «غير مُهيّأ»: لا تحاول به. السبب أن
`invalid_grant` من جوجل يشبه إلى حدّ بعيد «الرمز مرفوض»، والخلط بينهما يضيّع ساعة
على شخص يظنّ أن حسابه أُغلق.

حدّ الرفع: ملف نصي واحد ≤ 512KB، باسم بلا `/` ولا مسافات تحكم. الـresponse يعيد
`id` و`name` و`webViewLink` فقط — لا المالك ولا الأذونات.

## 5) بعد الضبط: الترتيب الصحيح للتحقق

```bash
# قبل النشر — صحة البيئة بلا شبكة وبلا طباعة أي قيمة
python scripts/deploy_doctor.py --target=render
python scripts/deploy_doctor.py --target=vercel

# بعد النشر — هل الرموز تعمل فعلًا؟ (يكتب لا شيء، ويُطبع محضرًا مُحمَّرًا)
WAHA_LIVE_INTEGRATIONS=1 python scripts/integrations_live_check.py
```

ثم افتح `/integrations`؛ البطاقات الثماني يجب أن تكون كلها «جاهز» للأزرار التي
ضبطتها، و«غير مُهيّأ» مع اسم المتغيّر للتي لم تضبطها.
