// Supabase Edge Function: notify
// orders INSERT を database webhook で受け取り、push_subscriptions の全端末へ Web Push を送信
// secrets:
//   VAPID_PUBLIC_KEY  - クライアントと同一の公開鍵
//   VAPID_PRIVATE_KEY - 秘密鍵
//   VAPID_SUBJECT     - mailto: のメールアドレス

import webpush from 'https://esm.sh/web-push@3.6.7?bundle';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const COLOR_LABEL: Record<string, string> = {
  yellow: 'Yellow', red: 'Red', blue: 'Blue', green: 'Green',
};

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    // Supabase Database Webhook payload: { type, table, record, old_record, schema }
    // 直接呼び出しの場合は body 自体を order と扱う
    const order = body.record || body;
    if (!order || !order.id) {
      return new Response(JSON.stringify({ ok: false, reason: 'no order' }), { status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: subs, error } = await supabase.from('push_subscriptions').select('*');
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
    }

    const colorLabel = COLOR_LABEL[order.color] || '';
    const seat = order.seat ? `席 ${order.seat}` : '席未選択';
    const dev = order.device_name ? `[${order.device_name}] ` : '';
    const src = order.source === 'preview' ? '（プレビュー）' : '';
    const title = `${dev}${seat}${src ? ' ' + src : ''}`.trim() || 'GENTLY DIVA';
    const castNames = (order.casts || []).map((c: any) => c.name).filter(Boolean).join(', ');
    const bodyText = `${colorLabel}${order.customer_name ? ' / ' + order.customer_name : ''}\n${castNames}`;

    const payload = JSON.stringify({
      title,
      body: bodyText,
      icon: '/host-menu-app/icon-192.png',
      tag: order.id,
      orderId: order.id,
      url: '/host-menu-app/admin.html',
    });

    const senderDeviceId = order.device_id || '';

    const results = await Promise.allSettled(
      (subs || [])
        .filter((s) => s.device_id !== senderDeviceId) // 送信端末には届けない
        .map(async (s) => {
          const subscription = {
            endpoint: s.endpoint,
            keys: { p256dh: s.p256dh, auth: s.auth },
          };
          try {
            await webpush.sendNotification(subscription, payload);
          } catch (err: any) {
            // 410 Gone / 404 -> 期限切れ。レコード削除
            if (err && (err.statusCode === 410 || err.statusCode === 404)) {
              await supabase.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
            }
            throw err;
          }
        })
    );

    const sent = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    return new Response(JSON.stringify({ ok: true, sent, failed }), { status: 200 });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), { status: 500 });
  }
});
