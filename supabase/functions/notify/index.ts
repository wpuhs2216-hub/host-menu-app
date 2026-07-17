// Supabase Edge Function: notify
// orders INSERT / UPDATE を database trigger で受け取り、push_subscriptions の全端末へ Web Push を送信
// secrets: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT

import webpush from 'https://esm.sh/web-push@3.6.7?bundle';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

// 色ラベルのデフォルト（store_settings に行が無い/未設定の店舗用）
const DEFAULT_COLOR_LABELS: Record<string, string> = {
  yellow: '壁側', red: '通路側', blue: '', green: '',
};
// 空欄時のフォールバック（従来の英語色名）
const COLOR_NAME_FALLBACK: Record<string, string> = {
  yellow: 'Yellow', red: 'Red', blue: 'Blue', green: 'Green',
};

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const op: string = (body.type || 'INSERT').toUpperCase(); // 'INSERT' | 'UPDATE'
    const order = body.record || body;
    if (!order || !order.id) {
      return new Response(JSON.stringify({ ok: false, reason: 'no order' }), { status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const storeId = order.store_id || 'gently-diva';
    // 同一店舗の購読端末のみに配信する（マルチ店舗の越境配信を防ぐ）
    const { data: subs, error } = await supabase
      .from('push_subscriptions').select('*').eq('store_id', storeId);
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
    }

    // 店舗設定の色ラベル（壁側/通路側など）を取得。無ければデフォルト → 空欄は英語色名
    let labels = { ...DEFAULT_COLOR_LABELS };
    try {
      const { data: st } = await supabase
        .from('store_settings').select('color_labels').eq('store_id', storeId).maybeSingle();
      if (st?.color_labels && typeof st.color_labels === 'object') {
        labels = { ...labels, ...st.color_labels };
      }
    } catch { /* 設定取得失敗時はデフォルトで続行 */ }
    const colorLabel = (labels[order.color] || '').trim() || COLOR_NAME_FALLBACK[order.color] || '';
    const seat = order.seat ? `席 ${order.seat}` : '席未選択';
    const dev = order.device_name ? `[${order.device_name}] ` : '';
    const src = order.source === 'preview' ? '（プレビュー）' : '';
    const titleBase = op === 'UPDATE' ? '初回ピックアップ（更新）' : '初回ピックアップ';
    const title = titleBase;
    const castNames = (order.casts || []).map((c: any) => c.name).filter(Boolean).join(', ');
    const bodyText = [
      `${dev}${seat}${src}`.trim(),
      `${colorLabel}${order.customer_name ? ' / ' + order.customer_name : ''}`,
      castNames,
    ].filter(Boolean).join('\n');

    const payload = JSON.stringify({
      title,
      body: bodyText,
      icon: '/host-menu-app/icon-192.png',
      tag: order.id,
      orderId: order.id,
      url: '/host-menu-app/admin.html',
    });

    const senderDeviceId = order.device_id || '';

    // 同一端末が複数 endpoint を登録している場合、最新の1件のみに送る（通知の重複防止）
    // endpoint 単位 upsert のため、再購読で古い endpoint 行が残ると同じ端末に複数届いてしまう
    const latestByDevice = new Map<string, any>();
    for (const s of subs || []) {
      const key = s.device_id || s.endpoint; // device_id 不明な古い行は endpoint 単位で残す
      const cur = latestByDevice.get(key);
      if (!cur || new Date(s.created_at || 0) > new Date(cur.created_at || 0)) {
        latestByDevice.set(key, s);
      }
    }

    const results = await Promise.allSettled(
      [...latestByDevice.values()]
        .filter((s) => s.device_id !== senderDeviceId) // 送信/編集元の端末には届けない
        .map(async (s) => {
          const subscription = {
            endpoint: s.endpoint,
            keys: { p256dh: s.p256dh, auth: s.auth },
          };
          try {
            await webpush.sendNotification(subscription, payload);
          } catch (err: any) {
            if (err && (err.statusCode === 410 || err.statusCode === 404)) {
              await supabase.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
            }
            throw err;
          }
        })
    );

    const sent = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    return new Response(JSON.stringify({ ok: true, op, sent, failed }), { status: 200 });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), { status: 500 });
  }
});
