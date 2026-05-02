// Supabase クライアント
// anon key は RLS で守られた公開鍵なのでソースに含めて問題ない
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://ktvenszzbejbioafiilc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt0dmVuc3p6YmVqYmlvYWZpaWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3MjgxNzYsImV4cCI6MjA5MzMwNDE3Nn0.0g1c2vQC_sD3eStYx29GDGyIY_UH5HBBPnJhXuAOiJs';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  realtime: {
    params: { eventsPerSecond: 5 },
  },
});

export const PANEL_BUCKET = 'panel-images';

// バケット内パスから公開URLを取得
export function publicImageUrl(path) {
  if (!path) return '';
  const { data } = supabase.storage.from(PANEL_BUCKET).getPublicUrl(path);
  return data?.publicUrl || '';
}
