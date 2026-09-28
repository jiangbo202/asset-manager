-- 补上被漏掉的结构标记
--
-- 0006 只做了三个 ALTER TABLE，忘了更新 settings.schema_version（每个迁移都要写）。
-- 后果非常隐蔽，而且会长久卡住用户：
--   列已经加上了 → 代码能正常工作；
--   但库仍自称 v5  → 应用认为“库落后于代码”，界面停在「数据库需要升级」；
--   迁移确实应用过了 → Wrangler 不会再来一遍（"No migrations to apply!"），
--   于是用户点「已升级，重试」无论如何都没有变化。
--
-- 迁移文件一旦被应用就不会重跑，所以只修 0006 对“已经跑过 0006 的库”无效 ——
-- 那些库需要这一条把版本号补上。幂等，重复执行无副作用。

INSERT INTO settings (key, value) VALUES ('schema_version', '6') ON CONFLICT (key) DO UPDATE SET value = '6';
