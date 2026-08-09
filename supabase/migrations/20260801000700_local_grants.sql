-- 本番 Supabase では anon ロールへの権限が自動付与されているが、
-- ローカルスタックでは migration で作ったテーブルに付かないため明示的に付与する。
-- （冪等・本番に流しても既存権限と同じなので無害）

grant usage on schema public to anon, authenticated, service_role;

grant all privileges on all tables    in schema public to anon, authenticated, service_role;
grant all privileges on all sequences in schema public to anon, authenticated, service_role;
grant all privileges on all functions in schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
