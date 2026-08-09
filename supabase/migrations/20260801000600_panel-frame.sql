-- v1.6.35: サムネフレーム（金/銀/銅）
-- panels.frame: 'gold' | 'silver' | 'bronze' | null（null=フレームなし）
alter table panels add column if not exists frame text;
