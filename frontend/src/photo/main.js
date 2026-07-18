import "./style.css";

const $ = (selector) => document.querySelector(selector);

const roleView = $("#role-view");
const computerView = $("#computer-view");
const phoneView = $("#phone-view");
const globalError = $("#global-error");
const computerStatus = $("#computer-status");
const computerPlaceholder = $("#computer-placeholder");
const computerMeta = $("#computer-meta");
const receivedVideo = $("#received-video");
const downloadVideo = $("#download-video");
const phoneStatus = $("#phone-status");
const phoneSettings = $("#phone-settings");
const phoneTransfer = $("#phone-transfer");
const phonePreview = $("#phone-preview");
const stopRecordingButton = $("#stop-recording");
const nativeCameraButton = $("#use-native-camera");
const nativeCameraInput = $("#native-camera-input");

let currentRole = null;
let socket = null;
let mediaStream = null;
let mediaRecorder = null;
let phoneBytesSent = 0;
let phoneCameraSettings = null;
let nativeVideoUrl = null;

let receivedMimeType = "video/webm";
let receivedChunks = [];
let receivedBytes = 0;
let mediaSource = null;
let mediaSourceUrl = null;
let sourceBuffer = null;
let sourceQueue = [];
let recordingEnded = false;
let mediaSourceFailed = false;
let downloadUrl = null;

function setHidden(element, hidden) {
  element.classList.toggle("hidden", hidden);
}

function setStatus(element, text, state = "") {
  element.textContent = text;
  const line = element.closest(".status-line");
  if (line) {
    line.dataset.state = state;
  }
}

function showError(message) {
  globalError.textContent = message;
  setHidden(globalError, !message);
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function socketUrl(role) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/photo?role=${role}`;
}

function openSocket(role) {
  return new Promise((resolve, reject) => {
    const websocket = new WebSocket(socketUrl(role));
    websocket.binaryType = "arraybuffer";
    socket = websocket;
    let opened = false;

    websocket.onopen = () => {
      opened = true;
      resolve(websocket);
    };
    websocket.onerror = () => {
      if (!opened) reject(new Error("WebSocket 连接失败"));
    };
    websocket.onclose = () => {
      if (socket !== websocket) return;
      socket = null;
      if (currentRole === "computer") {
        setStatus(computerStatus, "连接已断开", "error");
      } else if (currentRole === "phone") {
        setStatus(phoneStatus, "连接已断开，录像无法继续上传", "error");
      }
    };
    websocket.onmessage = (event) => {
      if (role === "computer") {
        handleComputerMessage(event);
      } else {
        handlePhoneMessage(event);
      }
    };
  });
}

function closeSocket() {
  if (socket && socket.readyState < WebSocket.CLOSING) {
    socket.close();
  }
  socket = null;
}

function showRole(role) {
  currentRole = role;
  setHidden(roleView, true);
  setHidden(computerView, role !== "computer");
  setHidden(phoneView, role !== "phone");
  showError("");
}

function chooseMimeType() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function updatePhoneMeta() {
  if (phoneCameraSettings) {
    const width = phoneCameraSettings.width || "?";
    const height = phoneCameraSettings.height || "?";
    const fps = phoneCameraSettings.frameRate ? Math.round(phoneCameraSettings.frameRate) : "?";
    phoneSettings.textContent = `实际采集 ${width}×${height} · ${fps}fps · 无音频`;
  }
  phoneTransfer.textContent = `已发送 ${formatBytes(phoneBytesSent)}`;
}

function releaseLiveCapture() {
  closeSocket();
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
  }
  mediaRecorder = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  phonePreview.srcObject = null;
  stopRecordingButton.disabled = true;
}

function readVideoMetadata(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      resolve({ width: video.videoWidth || null, height: video.videoHeight || null });
      URL.revokeObjectURL(url);
    };
    video.onerror = () => {
      resolve({ width: null, height: null });
      URL.revokeObjectURL(url);
    };
    video.src = url;
  });
}

async function waitForSocketBuffer() {
  while (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount > 4 * 1024 * 1024) {
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
}

function openNativeCamera() {
  releaseLiveCapture();
  phonePreview.controls = false;
  phoneBytesSent = 0;
  updatePhoneMeta();
  setStatus(phoneStatus, "正在打开系统相机", "working");
  nativeCameraInput.value = "";
  nativeCameraInput.click();
}

async function uploadNativeVideo(file) {
  const metadata = await readVideoMetadata(file);
  const mimeType = file.type || "video/mp4";
  phoneCameraSettings = metadata;
  phoneBytesSent = 0;
  updatePhoneMeta();
  phoneSettings.textContent = `系统相机文件 ${metadata.width || "?"}×${metadata.height || "?"} · 音频由系统相机决定`;

  setStatus(phoneStatus, "正在连接电脑", "working");
  await openSocket("phone");
  socket.send(JSON.stringify({
    type: "recording_start",
    mode: "native-camera",
    mime_type: mimeType,
    width: metadata.width,
    height: metadata.height,
    fps: null,
  }));

  const chunkSize = 512 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    if (socket?.readyState !== WebSocket.OPEN) {
      throw new Error("系统相机录像上传连接已断开");
    }
    const end = Math.min(offset + chunkSize, file.size);
    socket.send(await file.slice(offset, end).arrayBuffer());
    phoneBytesSent = end;
    updatePhoneMeta();
    await waitForSocketBuffer();
  }
  socket.send(JSON.stringify({ type: "recording_stop" }));
  if (nativeVideoUrl) URL.revokeObjectURL(nativeVideoUrl);
  nativeVideoUrl = URL.createObjectURL(file);
  phonePreview.srcObject = null;
  phonePreview.src = nativeVideoUrl;
  phonePreview.controls = true;
  phonePreview.muted = true;
  phonePreview.load();
  setStatus(phoneStatus, "系统相机录像已上传", "done");
}

async function handleNativeCameraFile() {
  const file = nativeCameraInput.files?.[0];
  if (!file) {
    setStatus(phoneStatus, "未选择系统相机录像", "error");
    return;
  }
  try {
    setStatus(phoneStatus, "正在上传系统相机录像", "working");
    await uploadNativeVideo(file);
  } catch (error) {
    closeSocket();
    setStatus(phoneStatus, "系统相机录像上传失败", "error");
    showError(error.message || "系统相机录像上传失败");
  }
}

async function startPhoneRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前浏览器不支持摄像头访问");
  }

  setStatus(phoneStatus, "正在请求摄像头权限", "working");
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 30, max: 30 },
      facingMode: { ideal: "environment" },
    },
  });
  phonePreview.srcObject = mediaStream;
  phoneCameraSettings = mediaStream.getVideoTracks()[0]?.getSettings() || null;
  phoneBytesSent = 0;
  updatePhoneMeta();

  setStatus(phoneStatus, "正在连接电脑", "working");
  await openSocket("phone");

  const mimeType = chooseMimeType();
  const recorderOptions = {
    videoBitsPerSecond: 8_000_000,
    ...(mimeType ? { mimeType } : {}),
  };
  mediaRecorder = new MediaRecorder(mediaStream, recorderOptions);
  mediaRecorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(event.data);
      phoneBytesSent += event.data.size;
      updatePhoneMeta();
    }
  };
  mediaRecorder.onerror = () => {
    setStatus(phoneStatus, "录像失败", "error");
  };
  mediaRecorder.onstop = () => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "recording_stop" }));
    }
    mediaStream?.getTracks().forEach((track) => track.stop());
    setStatus(phoneStatus, "录像已停止", "done");
    stopRecordingButton.disabled = true;
  };

  mediaRecorder.start(1000);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: "recording_start",
      mime_type: mediaRecorder.mimeType || mimeType || "video/webm",
      width: phoneCameraSettings?.width || null,
      height: phoneCameraSettings?.height || null,
      fps: phoneCameraSettings?.frameRate || 30,
    }));
  }
  stopRecordingButton.disabled = false;
  setStatus(phoneStatus, "正在录像并上传", "active");
}

function stopPhoneRecording() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  stopRecordingButton.disabled = true;
  setStatus(phoneStatus, "正在结束录像", "working");
  mediaRecorder.stop();
}

function clearReceivedVideo() {
  receivedVideo.pause();
  receivedVideo.removeAttribute("src");
  receivedVideo.load();
  if (mediaSourceUrl) URL.revokeObjectURL(mediaSourceUrl);
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  mediaSource = null;
  mediaSourceUrl = null;
  downloadUrl = null;
  sourceBuffer = null;
  sourceQueue = [];
  receivedChunks = [];
  receivedBytes = 0;
  recordingEnded = false;
  mediaSourceFailed = false;
  setHidden(downloadVideo, true);
  setHidden(computerPlaceholder, false);
}

function createDownloadVideo() {
  if (!receivedChunks.length || downloadUrl) return;
  const blob = new Blob(receivedChunks, { type: receivedMimeType });
  downloadUrl = URL.createObjectURL(blob);
  downloadVideo.href = downloadUrl;
  setHidden(downloadVideo, false);
  if (!mediaSource || mediaSourceFailed) {
    receivedVideo.src = downloadUrl;
    receivedVideo.load();
    receivedVideo.play().catch(() => {});
  }
}

function finishMediaSource() {
  if (!recordingEnded) return;
  if (mediaSource && !mediaSourceFailed && !sourceBuffer) return;
  if (!mediaSourceFailed && sourceBuffer && (sourceBuffer.updating || sourceQueue.length)) return;
  if (mediaSource && mediaSource.readyState === "open") {
    try {
      mediaSource.endOfStream();
    } catch {
      // The complete Blob below remains available even if MSE has already closed.
    }
  }
  createDownloadVideo();
}

function drainSourceBuffer() {
  if (!sourceBuffer || sourceBuffer.updating) return;
  if (!sourceQueue.length) {
    finishMediaSource();
    return;
  }
  try {
    sourceBuffer.appendBuffer(sourceQueue.shift());
  } catch {
    mediaSourceFailed = true;
    sourceQueue = [];
    setStatus(computerStatus, "正在接收，结束后生成完整视频", "working");
    finishMediaSource();
  }
}

function startReceiving(payload) {
  clearReceivedVideo();
  receivedMimeType = payload.mime_type || "video/webm";
  downloadVideo.download = receivedMimeType.includes("mp4")
    ? "phone-recording.mp4"
    : "phone-recording.webm";
  setHidden(computerPlaceholder, true);
  const fpsLabel = payload.fps ? `${Math.round(payload.fps)}fps` : "系统相机文件";
  computerMeta.textContent = `正在接收 · ${payload.width || "?"}×${payload.height || "?"} · ${fpsLabel}`;
  setStatus(computerStatus, "正在接收手机画面", "active");

  const canUseMediaSource = window.MediaSource
    && MediaSource.isTypeSupported(receivedMimeType);
  if (!canUseMediaSource) {
    mediaSourceFailed = true;
    return;
  }

  mediaSource = new MediaSource();
  mediaSourceUrl = URL.createObjectURL(mediaSource);
  receivedVideo.src = mediaSourceUrl;
  mediaSource.addEventListener("sourceopen", () => {
    try {
      sourceBuffer = mediaSource.addSourceBuffer(receivedMimeType);
      sourceBuffer.addEventListener("updateend", drainSourceBuffer);
      sourceBuffer.addEventListener("error", () => {
        mediaSourceFailed = true;
        sourceQueue = [];
        finishMediaSource();
      });
      drainSourceBuffer();
    } catch {
      mediaSourceFailed = true;
      finishMediaSource();
    }
  }, { once: true });
}

function receiveVideoChunk(buffer) {
  const chunk = new Uint8Array(buffer);
  receivedChunks.push(chunk);
  receivedBytes += chunk.byteLength;
  computerMeta.textContent = `正在接收 · ${formatBytes(receivedBytes)}`;
  if (mediaSource && !mediaSourceFailed) {
    sourceQueue.push(chunk);
    drainSourceBuffer();
  }
  receivedVideo.play().catch(() => {});
}

function handleComputerPayload(payload) {
  if (payload.type === "relay_ready") {
    setStatus(
      computerStatus,
      payload.peer_connected ? "手机已连接，等待录像" : "等待手机连接",
      payload.peer_connected ? "working" : "",
    );
  } else if (payload.type === "phone_connected") {
    setStatus(computerStatus, "手机已连接，等待录像", "working");
  } else if (payload.type === "recording_start") {
    startReceiving(payload);
  } else if (payload.type === "recording_stop") {
    recordingEnded = true;
    setStatus(computerStatus, "录像接收完成", "done");
    computerMeta.textContent = `接收完成 · ${formatBytes(receivedBytes)}`;
    finishMediaSource();
  } else if (payload.type === "phone_disconnected") {
    setStatus(computerStatus, "手机已断开", "error");
    if (receivedBytes) {
      computerMeta.textContent = `已收到 ${formatBytes(receivedBytes)} · 等待结束信号`;
    }
  }
}

function handleComputerMessage(event) {
  if (typeof event.data === "string") {
    try {
      handleComputerPayload(JSON.parse(event.data));
    } catch {
      // Ignore malformed temporary relay messages.
    }
    return;
  }
  if (event.data instanceof Blob) {
    event.data.arrayBuffer().then(receiveVideoChunk);
  } else {
    receiveVideoChunk(event.data);
  }
}

function handlePhoneMessage(event) {
  if (typeof event.data !== "string") return;
  try {
    const payload = JSON.parse(event.data);
    if (payload.type === "relay_ready") {
      setStatus(
        phoneStatus,
        payload.peer_connected ? "电脑已连接，正在录像" : "电脑未连接，等待电脑打开",
        payload.peer_connected ? "active" : "working",
      );
    } else if (payload.type === "computer_connected") {
      setStatus(phoneStatus, "电脑已连接，正在录像", "active");
      if (mediaRecorder?.state === "recording" && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: "recording_start",
          mime_type: mediaRecorder.mimeType || "video/webm",
          width: phoneCameraSettings?.width || null,
          height: phoneCameraSettings?.height || null,
          fps: phoneCameraSettings?.frameRate || 30,
        }));
      }
    } else if (payload.type === "computer_disconnected") {
      setStatus(phoneStatus, "电脑已断开，上传仍会继续", "error");
    }
  } catch {
    // Ignore malformed temporary relay messages.
  }
}

async function chooseComputer() {
  showRole("computer");
  clearReceivedVideo();
  setStatus(computerStatus, "正在连接", "working");
  try {
    await openSocket("computer");
  } catch (error) {
    setStatus(computerStatus, "连接失败", "error");
    showError(error.message);
  }
}

async function choosePhone() {
  showRole("phone");
  try {
    await startPhoneRecording();
  } catch (error) {
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
    closeSocket();
    setStatus(phoneStatus, "无法开始录像", "error");
    showError(error.message || "无法访问摄像头");
  }
}

function resetToRoleSelection() {
  currentRole = null;
  releaseLiveCapture();
  phonePreview.srcObject = null;
  phonePreview.removeAttribute("src");
  phonePreview.controls = false;
  if (nativeVideoUrl) URL.revokeObjectURL(nativeVideoUrl);
  nativeVideoUrl = null;
  nativeCameraInput.value = "";
  clearReceivedVideo();
  setHidden(roleView, false);
  setHidden(computerView, true);
  setHidden(phoneView, true);
  setHidden(stopRecordingButton, false);
  stopRecordingButton.disabled = true;
  showError("");
}

$("#choose-computer").addEventListener("click", chooseComputer);
$("#choose-phone").addEventListener("click", choosePhone);
$("#computer-reset").addEventListener("click", resetToRoleSelection);
$("#phone-reset").addEventListener("click", resetToRoleSelection);
stopRecordingButton.addEventListener("click", stopPhoneRecording);
nativeCameraButton.addEventListener("click", openNativeCamera);
nativeCameraInput.addEventListener("change", handleNativeCameraFile);
