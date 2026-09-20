const worker = new Worker(`${import.meta.env.BASE_URL}pyodide-worker.js`);

let requestId = 0;
const pending = new Map();
const progressHandlers = new Set();
const errorHandlers = new Set();

worker.onmessage = (event) => {
  const message = event.data;
  if (message.type === "progress") {
    progressHandlers.forEach((handler) => handler(message.value, message.label));
    return;
  }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.type === "error") request.reject(new Error(message.message));
  else request.resolve(message);
};

worker.onerror = (event) => {
  errorHandlers.forEach((handler) => handler(event.message || "后台处理错误"));
};

export function workerCall(type, payload = {}, transfers = []) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type, id, ...payload }, transfers);
  });
}

export function onWorkerProgress(handler) {
  progressHandlers.add(handler);
}

export function onWorkerError(handler) {
  errorHandlers.add(handler);
}
