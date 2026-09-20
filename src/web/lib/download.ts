/** 触发浏览器下载文本文件（备份导出用） */
export function downloadText(filename: string, text: string): void {
	const blob = new Blob([text], { type: "application/json;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	// 让浏览器有机会开始下载再释放
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 人类可读的字节数 */
export function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
