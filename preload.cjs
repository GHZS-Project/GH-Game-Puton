const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appApi', {
  选择资料文件夹: () => ipcRenderer.invoke('选择资料文件夹'),
  打开路径: (targetPath) => ipcRenderer.invoke('打开路径', targetPath),
  运行任务: (options) => ipcRenderer.invoke('运行任务', options),
  停止任务: () => ipcRenderer.invoke('停止任务'),
  on日志: (callback) => ipcRenderer.on('任务日志', (_event, message) => callback(message)),
  on状态: (callback) => ipcRenderer.on('任务状态', (_event, status) => callback(status)),
});
