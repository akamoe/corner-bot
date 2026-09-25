export function GET() {
  const html = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Corner</title><body style="font:20px system-ui;margin:3rem auto;max-width:36rem;padding:1rem">
<h1>🌽 Corner</h1><p>رجعت من صفحة الدفع. راح نأكد طلبك بالبوت من يوصلنا تأكيد الدفع.</p>
<p>الرجوع لهنا وحده ما يعني إن الدفع تم.</p><a href="https://t.me/corner_rest_bot">ارجع للبوت وتابع حالة الدفع</a>
</body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}
