-- 署名時刻をサーバ時刻にする（2026-09-17）
-- 端末の時計を変えれば署名日時を偽装できる状態だったため、DB 側で必ず上書きする。
-- 端末が主張した時刻は device_signed_at に参考値として残す。
-- 古い版のアプリ（signed_at を送ってくる）からの INSERT でも、トリガーが正しい形に寄せる。

alter table public.consents add column if not exists device_signed_at timestamptz;

comment on column public.consents.signed_at is 'サーバ時刻。クライアントが何を送ってもトリガーで上書きする（偽装不可）';
comment on column public.consents.device_signed_at is '端末が主張した署名時刻。端末の時計次第なので参考値';

create or replace function public.consents_force_server_time()
returns trigger
language plpgsql
as $$
begin
  -- 端末の主張を device_signed_at へ寄せてから、signed_at をサーバ時刻で上書きする
  if new.device_signed_at is null then
    new.device_signed_at := new.signed_at;
  end if;
  new.signed_at := now();
  return new;
end;
$$;

drop trigger if exists trg_consents_force_server_time on public.consents;
create trigger trg_consents_force_server_time
  before insert on public.consents
  for each row execute function public.consents_force_server_time();
