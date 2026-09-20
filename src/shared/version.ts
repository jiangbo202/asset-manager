/** 应用与数据结构版本（备份文件里会带上，导入时做兼容性校验） */
export const APP_VERSION = "0.10.0";

/** 备份文件格式版本；schema 不兼容变更时 +1 */
export const BACKUP_SCHEMA_VERSION = 1;

/** 备份文件标识，避免用户误传别的 JSON */
export const BACKUP_FORMAT = "asset-manager-backup";
