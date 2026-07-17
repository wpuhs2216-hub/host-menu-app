
### Tool call: browser_run_code_unsafe
- Args
```json
{
  "code": "async (page) => {\n  await page.goto('https://supabase.com/dashboard/project/ktvenszzbejbioafiilc/sql/new', { waitUntil: 'domcontentloaded', timeout: 30000 });\n  await page.waitForTimeout(4000);\n  const url = page.url();\n  const title = await page.title();\n  const bodySnippet = (await page.textContent('body') || '').slice(0, 300);\n  return { url, title, bodySnippet };\n}"
}
```
- Result
```json
{
  "result": "{\"url\":\"https://supabase.com/dashboard/sign-in?returnTo=%2Fproject%2Fktvenszzbejbioafiilc%2Fsql%2Fnew\",\"title\":\"Supabase\",\"bodySnippet\":\"{\\\"adminStudioLink\\\":false,\\\"aikidoDashboardIntegrationEnabled\\\":false,\\\"allowDataBranching\\\":false,\\\"analyticsBucketsTableCreation\\\":false,\\\"auditLogsLogDrain\\\":true,\\\"authOverviewPage\\\":false,\\\"clockSkewBanner\\\":false,\\\"customDomainsDisabledDueToQuota\\\":false,\\\"dashboardPreferences\\\":false,\\\"databaseLogsConfiguratio\"}",
  "code": "await (async (page) => {\n  await page.goto('https://supabase.com/dashboard/project/ktvenszzbejbioafiilc/sql/new', { waitUntil: 'domcontentloaded', timeout: 30000 });\n  await page.waitForTimeout(4000);\n  const url = page.url();\n  const title = await page.title();\n  const bodySnippet = (await page.textContent('body') || '').slice(0, 300);\n  return { url, title, bodySnippet };\n})(page);",
  "page": "- Page URL: https://supabase.com/dashboard/sign-in?returnTo=%2Fproject%2Fktvenszzbejbioafiilc%2Fsql%2Fnew\n- Page Title: Supabase\n- Console: 2 errors, 4 warnings",
  "events": "- New console entries: .playwright-mcp/console-2026-07-16T12-25-36-992Z.log#L1-L7"
}
```
