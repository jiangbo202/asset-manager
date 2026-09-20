/** 应用与数据结构版本（备份文件里会带上，导入时做兼容性校验） */
export const APP_VERSION = "0.12.0";

/** 数据库结构版本（与 migrations 目录里的最新迁移对应；用于检测"库落后于代码"） */
export const SCHEMA_VERSION = 3;

/** 备份文件格式版本；schema 不兼容变更时 +1 */
export const BACKUP_SCHEMA_VERSION = 1;

/** 备份文件标识，避免用户误传别的 JSON */
export const BACKUP_FORMAT = "asset-manager-backup";
