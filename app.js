import { ArrayBufferTarget, Muxer } from "./vendor/mp4-muxer.mjs";

const FPS = 30;
const MAX_SECONDS = 120;

const state = {
  A: null,
  B: null,
  scale: 1,
  dx: 0,
  dy: 0,
  opacity: 0.5,
  playing: false,
  exporting: false,
  cancel: false,
  ready: true,
};

const $ = (id) => document.getElementById(id);
const canvas = $("stage");
const ctx = canvas.getContext("2d", { alpha: false });
const pointers = new Map();

$("fileA").addEventListener("change", (e) => loadFile(e.target.files[0], "A"));
$("fileB").addEventListener("change", (e) => loadFile(e.target.files[0], "B"));
$("sampleBtn").addEventListener("click", loadSamples);
$("scale").addEventListener("input", () => {
  state.scale = Number($("scale").value);
  updateSliderLabels();
  drawIfReady();
});
$("opacity").addEventListener("input", () => {
  state.opacity = Number($("opacity").value);
  updateSliderLabels();
  drawIfReady();
});
for (const slot of ["A", "B"]) {
  $("vol" + slot).addEventListener("input", () => {
    const value = Number($("vol" + slot).value);
    if (state[slot]) state[slot].volume = value;
    if (state[slot]?.gainNode) state[slot].gainNode.gain.value = value;
    updateSliderLabels();
  });
}
$("resetBtn").addEventListener("click", () => {
  stopPlayback();
  resetTransform();
  prepareAlign();
});
$("previewBtn").addEventListener("click", () => {
  armAudio();
  primeBoth();
  if (state.playing) stopPlayback();
  else startPreview();
});
$("exportBtn").addEventListener("click", () => {
  armAudio();
  primeBoth();
  exportMp4();
});
$("cancelBtn").addEventListener("click", () => {
  state.cancel = true;
});
$("shareBtn").addEventListener("click", shareResult);

for (const slot of ["A", "B"]) {
  $("back" + slot).addEventListener("click", () => step(slot, -1));
  $("fwd" + slot).addEventListener("click", () => step(slot, 1));
  $("markIn" + slot).addEventListener("click", () => mark(slot, "in"));
  $("markOut" + slot).addEventListener("click", () => mark(slot, "out"));
  $("scrub" + slot).addEventListener("input", () => {
    const item = state[slot];
    if (!item || state.exporting) return;
    stopPlayback();
    item.video.currentTime = Number($("scrub" + slot).value);
  });
}

canvas.addEventListener("pointerdown", (e) => {
  if (state.exporting) return;
  stopPlayback();
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // 合成イベントや一部のタッチでは捕獲できないことがある
  }
  pointers.set(e.pointerId, pointerPos(e));
  if (pointers.size === 1) prepareAlign();
  if (pointers.size === 2) {
    state.pinch = { dist: pointerDistance(), scale: state.scale };
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId) || !state.ready) return;
  const prev = pointers.get(e.pointerId);
  const pos = pointerPos(e);
  pointers.set(e.pointerId, pos);
  if (pointers.size === 1) {
    state.dx += pos.x - prev.x;
    state.dy += pos.y - prev.y;
    draw();
  } else if (state.pinch && state.pinch.dist > 0) {
    state.scale = clamp(state.pinch.scale * (pointerDistance() / state.pinch.dist), 0.25, 4);
    $("scale").value = String(state.scale);
    updateSliderLabels();
    draw();
  }
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) state.pinch = null;
};
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);

function primeBoth() {
  for (const slot of ["A", "B"]) {
    const video = state[slot]?.video;
    if (!video) continue;
    const pending = video.play();
    if (pending) pending.then(() => video.pause()).catch(() => {});
  }
}

async function loadSamples() {
  $("sampleBtn").disabled = true;
  setStatus("サンプルを読み込んでいます。");
  try {
    const main = await fetch("samples/ex_gs.mp4");
    const ghost = await fetch("samples/how_demo.mp4");
    if (!main.ok || !ghost.ok) throw new Error("サンプル動画が見つかりません。");
    await loadFile(new File([await main.blob()], "ex_gs.mp4", { type: "video/mp4" }), "A");
    await loadFile(new File([await ghost.blob()], "how_demo.mp4", { type: "video/mp4" }), "B");
    setStatus("サンプルを読み込みました。開始と終了を印してください。");
  } catch (error) {
    setStatus(error.message || "サンプルを読めませんでした。");
  } finally {
    $("sampleBtn").disabled = false;
  }
}

async function loadFile(file, slot) {
  if (!file) return;
  stopPlayback();
  setStatus(`${file.name} を読み込んでいます。`);
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.className = "clip-video";
  video.playsInline = true;
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  const still = document.createElement("video");
  still.className = "still";
  still.playsInline = true;
  still.muted = true;
  still.preload = "auto";
  still.src = url;
  document.body.appendChild(still);
  try {
    await waitEvent(video, "loadeddata");
    await Promise.race([
      waitEvent(still, "loadeddata"),
      delay(2500),
    ]);
  } catch {
    still.remove();
    URL.revokeObjectURL(url);
    setStatus("この動画は読めませんでした。別の MP4 を選んでください。");
    return;
  }
  if (state[slot]?.url) URL.revokeObjectURL(state[slot].url);
  releaseAudio(state[slot]);
  state[slot]?.still?.remove();
  state[slot] = {
    video,
    still: still.videoWidth ? still : null,
    url,
    name: file.name,
    in: 0,
    out: video.duration,
    volume: Number($("vol" + slot).value),
    audioBuffer: null,
    audioReady: decodeAudio(file),
  };
  if (!state[slot].still) still.remove();
  $("mount" + slot).replaceChildren(video);
  $("name" + slot).textContent = file.name;
  const scrub = $("scrub" + slot);
  scrub.disabled = false;
  scrub.max = String(video.duration);
  scrub.value = "0";
  for (const id of ["back", "fwd", "markIn", "markOut"]) $(id + slot).disabled = false;
  video.addEventListener("seeked", () => syncClock(slot));
  video.addEventListener("timeupdate", () => syncClock(slot));
  if (slot === "A") fitCanvas(video);
  resetTransform();
  syncClock(slot);
  updateMarks();
  prepareAlign();
  setStatus(`${file.name} を読み込みました。`);
}

function fitCanvas(video) {
  const { w, h } = outputSize(video);
  canvas.width = w;
  canvas.height = h;
}

function outputSize(video) {
  const vw = video.videoWidth || 1920;
  const vh = video.videoHeight || 1080;
  const fit = Math.min(1920 / vw, 1080 / vh);
  let w = Math.max(2, Math.round(vw * fit));
  let h = Math.max(2, Math.round(vh * fit));
  if (w % 2) w -= 1;
  if (h % 2) h -= 1;
  return { w, h };
}

function step(slot, direction) {
  const item = state[slot];
  if (!item || state.exporting) return;
  stopPlayback();
  const next = clamp(item.video.currentTime + direction / FPS, 0, item.video.duration);
  item.video.currentTime = next;
}

function mark(slot, which) {
  const item = state[slot];
  if (!item || state.exporting) return;
  stopPlayback();
  item[which] = item.video.currentTime;
  updateMarks();
  if (which === "in") {
    const plate = item.still || item.video;
    seek(plate, item.in).then(() => draw());
  }
}

function updateMarks() {
  for (const slot of ["A", "B"]) {
    const item = state[slot];
    $("inLabel" + slot).textContent = item ? `開始 ${formatTime(item.in)}` : "開始 0:00.0";
    $("outLabel" + slot).textContent = item ? `終了 ${formatTime(item.out)}` : "終了 —";
    $("card" + slot).classList.toggle("bad", Boolean(item) && item.out - item.in <= 0.05);
  }
  const dur = clipLength();
  const ready = dur > 0.05 && dur <= MAX_SECONDS;
  $("previewBtn").disabled = !ready || state.exporting;
  $("exportBtn").disabled = !ready || state.exporting;
  if (!state.A || !state.B) {
    $("lengthLabel").textContent = "2本の動画を読み込むと、書き出す長さが出ます。";
    return;
  }
  const a = state.A.out - state.A.in;
  const b = state.B.out - state.B.in;
  if (a <= 0.05 || b <= 0.05) {
    $("lengthLabel").textContent = "開始より後ろに終了を置いてください。";
    return;
  }
  if (Math.min(a, b) > MAX_SECONDS) {
    $("lengthLabel").textContent = "書き出す長さが2分を超えています。終了点を前に切ってください。";
    return;
  }
  const which = a <= b ? "メイン" : "ゴースト";
  $("lengthLabel").textContent = `書き出す長さ ${Math.min(a, b).toFixed(1)} 秒（${which}の終了点で止まります）`;
}

function clipLength() {
  if (!state.A || !state.B) return 0;
  return Math.min(state.A.out - state.A.in, state.B.out - state.B.in);
}

function resetTransform() {
  state.scale = 1;
  state.dx = 0;
  state.dy = 0;
  state.pinch = null;
  $("scale").value = "1";
  updateSliderLabels();
}

function updateSliderLabels() {
  $("scaleOut").textContent = `${Math.round(state.scale * 100)}%`;
  $("opacityOut").textContent = `${Math.round(state.opacity * 100)}%`;
  $("volOutA").textContent = `${Math.round(Number($("volA").value) * 100)}%`;
  $("volOutB").textContent = `${Math.round(Number($("volB").value) * 100)}%`;
}

function drawIfReady() {
  if (videosAtIn()) draw();
  else prepareAlign();
}

let alignToken = 0;
async function prepareAlign() {
  const token = ++alignToken;
  state.ready = false;
  await refreshAlign();
  if (token === alignToken) state.ready = true;
}

function plateOf(item) {
  if (!item) return null;
  return item.still?.videoWidth ? item.still : item.video;
}

async function refreshAlign() {
  const plates = [state.A, state.B].filter(Boolean).map((item) => ({
    video: plateOf(item),
    time: item.in,
  }));
  if (plates.length) {
    await Promise.all(plates.map((plate) => seek(plate.video, plate.time)));
    await nextFrame();
  }
  draw();
}

function videosAtIn() {
  if (!state.A || !state.B) return false;
  const a = plateOf(state.A);
  const b = plateOf(state.B);
  return Math.abs(a.currentTime - state.A.in) < 0.03
    && Math.abs(b.currentTime - state.B.in) < 0.03;
}

function draw(fromPlayback = false) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const a = fromPlayback ? state.A?.video : plateOf(state.A);
  const b = fromPlayback ? state.B?.video : plateOf(state.B);
  if (a?.videoWidth) paint(a, 1, 1, 0, 0);
  if (b?.videoWidth) paint(b, state.opacity, state.scale, state.dx, state.dy);
}

function paint(video, alpha, userScale, dx, dy) {
  const fit = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
  const dw = video.videoWidth * fit;
  const dh = video.videoHeight * fit;
  const w = dw * userScale;
  const h = dh * userScale;
  const x = (canvas.width - dw) / 2 + (dw - w) / 2 + dx;
  const y = (canvas.height - dh) / 2 + (dh - h) / 2 + dy;
  ctx.globalAlpha = alpha;
  ctx.drawImage(video, x, y, w, h);
  ctx.globalAlpha = 1;
}

function pointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  const sx = rect.width ? canvas.width / rect.width : 1;
  const sy = rect.height ? canvas.height / rect.height : 1;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

function pointerDistance() {
  const pts = [...pointers.values()];
  if (pts.length < 2) return 0;
  return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
}

async function startPreview() {
  const dur = clipLength();
  if (dur <= 0.05) return;
  state.playing = true;
  $("previewBtn").textContent = "停止";
  setStatus("プレビューを再生しています。");
  try {
    await playRange(dur);
    setStatus("プレビューが終わりました。");
  } catch (error) {
    console.error(error);
    setStatus("再生できませんでした。もう一度プレビューを押してください。");
  } finally {
    stopPlayback();
    prepareAlign();
  }
}

function stopPlayback() {
  state.playing = false;
  state.A?.video.pause();
  state.B?.video.pause();
  $("previewBtn").textContent = "プレビュー";
}

async function playRange(dur) {
  await Promise.all([
    seek(state.A.video, state.A.in),
    seek(state.B.video, state.B.in),
  ]);
  const start = performance.now();
  await Promise.all([state.A.video.play(), state.B.video.play()]);
  while (state.playing && performance.now() - start < dur * 1000) {
    const elapsed = (performance.now() - start) / 1000;
    correctDrift(state.A, elapsed);
    correctDrift(state.B, elapsed);
    draw(true);
    await nextFrame();
  }
  state.A.video.pause();
  state.B.video.pause();
}

function correctDrift(item, elapsed) {
  const target = item.in + elapsed;
  if (Math.abs(item.video.currentTime - target) > 0.12) item.video.currentTime = target;
}

async function exportMp4() {
  const dur = clipLength();
  if (dur <= 0.05 || dur > MAX_SECONDS || state.exporting) return;
  stopPlayback();
  state.exporting = true;
  state.cancel = false;
  $("exportBtn").disabled = true;
  $("previewBtn").disabled = true;
  $("cancelBtn").hidden = false;
  $("progress").hidden = false;
  $("progress").value = 0;
  setStatus("書き出しの準備をしています。");
  try {
    const blob = await encodeFrames(dur);
    if (state.cancel) {
      setStatus("書き出しを中止しました。");
      return;
    }
    showResult(blob);
  } catch (error) {
    console.error(error);
    setStatus("このブラウザでは MP4 を書き出せませんでした。同じページを Windows の PC（Chrome または Edge）で開いて、もう一度書き出してください。");
  } finally {
    state.exporting = false;
    $("cancelBtn").hidden = true;
    $("progress").hidden = true;
    updateMarks();
    prepareAlign();
  }
}

function releaseAudio(item) {
  if (!item) return;
  try { item.sourceNode?.disconnect(); } catch { /* already disconnected */ }
  try { item.gainNode?.disconnect(); } catch { /* already disconnected */ }
}

function ensureAudioContext() {
  if (!state.audioCtx) state.audioCtx = new AudioContext();
  return state.audioCtx;
}

function armAudio() {
  const ctx = ensureAudioContext();
  ctx.resume();
  for (const slot of ["A", "B"]) {
    const item = state[slot];
    if (!item) continue;
    item.video.muted = false;
    item.volume = Number($("vol" + slot).value);
    if (!item.sourceNode) {
      item.sourceNode = ctx.createMediaElementSource(item.video);
      item.gainNode = ctx.createGain();
      item.sourceNode.connect(item.gainNode);
      item.gainNode.connect(ctx.destination);
    }
    item.gainNode.gain.value = item.volume;
  }
}

async function decodeAudio(file) {
  const ctx = new AudioContext();
  try {
    const raw = await file.arrayBuffer();
    return await ctx.decodeAudioData(raw);
  } catch {
    return null;
  } finally {
    await ctx.close();
  }
}

async function pickAudioCodec() {
  if (typeof AudioEncoder === "undefined") return null;
  const candidates = [
    { codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 },
    { codec: "mp4a.40.2", sampleRate: 44100, numberOfChannels: 2, bitrate: 128000 },
  ];
  for (const config of candidates) {
    try {
      const support = await AudioEncoder.isConfigSupported(config);
      if (support.supported) return { ...config, ...(support.config || {}) };
    } catch {
      // try the next rate
    }
  }
  return null;
}

async function collectAudioChunks(duration, config) {
  const mixed = await mixAudio(duration, config.sampleRate);
  const chunks = [];
  let encodeError = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => chunks.push({ chunk, meta }),
    error: (error) => {
      encodeError = error;
    },
  });
  encoder.configure(config);
  const frameSize = 1024;
  for (let offset = 0; offset < mixed.left.length; offset += frameSize) {
    const data = new Float32Array(frameSize * 2);
    data.set(mixed.left.subarray(offset, offset + frameSize));
    data.set(mixed.right.subarray(offset, offset + frameSize), frameSize);
    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate: config.sampleRate,
      numberOfFrames: frameSize,
      numberOfChannels: 2,
      timestamp: Math.round((offset / config.sampleRate) * 1e6),
      data,
    });
    encoder.encode(audioData);
    audioData.close();
    if (encodeError) throw encodeError;
  }
  await encoder.flush();
  if (encodeError) throw encodeError;
  encoder.close();
  return chunks;
}

async function mixAudio(duration, sampleRate) {
  const total = Math.ceil(duration * sampleRate);
  const left = new Float32Array(Math.ceil(total / 1024) * 1024);
  const right = new Float32Array(left.length);
  for (const item of [state.A, state.B]) {
    const buf = item?.audioBuffer;
    if (!buf || item.volume <= 0) continue;
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
    const start = item.in * buf.sampleRate;
    for (let i = 0; i < total; i += 1) {
      const srcPos = start + (i * buf.sampleRate) / sampleRate;
      const i0 = Math.floor(srcPos);
      if (i0 < 0 || i0 >= ch0.length) continue;
      const i1 = Math.min(i0 + 1, ch0.length - 1);
      const frac = srcPos - i0;
      left[i] += (ch0[i0] * (1 - frac) + ch0[i1] * frac) * item.volume;
      right[i] += (ch1[i0] * (1 - frac) + ch1[i1] * frac) * item.volume;
      if (i % 24000 === 0) await delay(0);
    }
  }
  for (let i = 0; i < total; i += 1) {
    left[i] = clamp(left[i], -1, 1);
    right[i] = clamp(right[i], -1, 1);
  }
  return { left, right };
}

async function encodeFrames(dur) {
  const width = canvas.width;
  const height = canvas.height;
  const config = await pickCodec(width, height);
  if (!config) throw new Error("encoder unsupported");
  state.A.audioBuffer = await state.A.audioReady;
  state.B.audioBuffer = await state.B.audioReady;
  state.A.volume = Number($("volA").value);
  state.B.volume = Number($("volB").value);
  const audioCodec = await pickAudioCodec();
  const audible = [state.A, state.B].some((item) => item.audioBuffer && item.volume > 0);
  let audioChunks = null;
  if (audioCodec && audible) {
    try {
      audioChunks = await collectAudioChunks(dur, audioCodec);
    } catch (error) {
      console.warn(error);
      audioChunks = null;
    }
  }
  state.exportedAudio = Boolean(audioChunks?.length);
  state.audioFailed = audible && !state.exportedAudio;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width, height, frameRate: FPS },
    audio: audioChunks?.length ? {
      codec: "aac",
      numberOfChannels: 2,
      sampleRate: audioCodec.sampleRate,
    } : undefined,
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });
  if (audioChunks?.length) {
    for (const part of audioChunks) muxer.addAudioChunk(part.chunk, part.meta);
  }
  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      encodeError = error;
    },
  });
  encoder.configure(config);
  const count = Math.max(1, Math.floor(dur * FPS));
  await Promise.all([
    seek(state.A.video, state.A.in),
    seek(state.B.video, state.B.in),
  ]);
  let playing = false;
  try {
    await Promise.all([state.A.video.play(), state.B.video.play()]);
    playing = true;
  } catch (error) {
    console.warn("playback export unavailable, seeking frame by frame", error);
  }
  const clock = performance.now();
  for (let i = 0; i < count; i += 1) {
    if (state.cancel) {
      state.A.video.pause();
      state.B.video.pause();
      encoder.close();
      return null;
    }
    if (encodeError) throw encodeError;
    const elapsed = i / FPS;
    if (playing) {
      while ((performance.now() - clock) / 1000 < elapsed) await nextFrame();
      correctDrift(state.A, elapsed);
      correctDrift(state.B, elapsed);
    } else {
      await Promise.all([
        seek(state.A.video, state.A.in + elapsed),
        seek(state.B.video, state.B.in + elapsed),
      ]);
    }
    await nextFrame();
    draw(true);
    const frame = new VideoFrame(canvas, {
      timestamp: Math.round((i * 1_000_000) / FPS),
      duration: Math.round(1_000_000 / FPS),
    });
    encoder.encode(frame, { keyFrame: i % FPS === 0 });
    frame.close();
    while (encoder.encodeQueueSize > 8) await delay(10);
    if (i % 5 === 0) {
      $("progress").value = (i + 1) / count;
      setStatus(`書き出し中 ${i + 1} / ${count} フレーム`);
    }
  }
  state.A.video.pause();
  state.B.video.pause();
  await encoder.flush();
  if (encodeError) throw encodeError;
  encoder.close();
  muxer.finalize();
  return new Blob([target.buffer], { type: "video/mp4" });
}

async function pickCodec(width, height) {
  if (typeof VideoEncoder === "undefined") return null;
  const codecs = ["avc1.420028", "avc1.4d0028", "avc1.640028", "avc1.42E028"];
  for (const codec of codecs) {
    const config = {
      codec,
      width,
      height,
      bitrate: 4_000_000,
      framerate: FPS,
      avc: { format: "avc" },
      latencyMode: "quality",
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return { ...config, ...(support.config || {}), avc: { format: "avc" } };
    } catch {
      // try the next profile
    }
  }
  return null;
}

function showResult(blob) {
  if (!blob || blob.size < 1000) throw new Error("empty file");
  const url = URL.createObjectURL(blob);
  const video = $("resultVideo");
  if (video.dataset.url) URL.revokeObjectURL(video.dataset.url);
  video.dataset.url = url;
  video.src = url;
  const link = $("downloadLink");
  link.href = url;
  link.download = "ski-ghostline.mp4";
  $("resultWrap").hidden = false;
  const file = new File([blob], "ski-ghostline.mp4", { type: "video/mp4" });
  state.resultFile = file;
  const canShare = navigator.canShare && navigator.canShare({ files: [file] });
  $("shareBtn").hidden = !canShare;
  video.addEventListener("loadedmetadata", () => {
    const sound = state.exportedAudio
      ? "音声あり"
      : state.audioFailed
        ? "音声は入れられませんでした。映像だけです"
        : "元の動画に音声がありません";
    setStatus(`書き出しました。${video.videoWidth}×${video.videoHeight}、${video.duration.toFixed(1)} 秒、${(blob.size / 1_000_000).toFixed(1)} MB、${sound}。下の動画で確認して保存できます。`);
  }, { once: true });
  setStatus("書き出しました。確認用の動画を準備しています。");
}

async function shareResult() {
  if (!state.resultFile || !navigator.share) return;
  try {
    await navigator.share({ files: [state.resultFile], title: "ski-ghostline" });
  } catch (error) {
    if (error.name !== "AbortError") setStatus("共有できませんでした。保存ボタンからファイルを渡してください。");
  }
}

function syncClock(slot) {
  const item = state[slot];
  if (!item) return;
  const frame = Math.round(item.video.currentTime * FPS);
  $("clock" + slot).textContent = `${formatTime(item.video.currentTime)}（${frame}コマ）`;
  const scrub = $("scrub" + slot);
  if (document.activeElement !== scrub) scrub.value = String(item.video.currentTime);
}

function setStatus(text) {
  $("status").textContent = text;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00.0";
  const m = Math.floor(seconds / 60);
  const s = (seconds - m * 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function seek(video, time) {
  const target = clamp(time, 0, Math.max(0, (video.duration || 0) - 0.001));
  if (Math.abs(video.currentTime - target) < 0.0005) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 1000);
    video.addEventListener("seeked", done);
    try {
      video.currentTime = target;
    } catch {
      done();
    }
  });
}

function waitEvent(target, name) {
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error(name)); };
    const cleanup = () => {
      target.removeEventListener(name, ok);
      target.removeEventListener("error", bad);
    };
    target.addEventListener(name, ok, { once: true });
    target.addEventListener("error", bad, { once: true });
  });
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

updateSliderLabels();
draw();

fetch("samples/ex_gs.mp4", { method: "HEAD" }).then((res) => {
  if (res.ok) $("sampleBtn").hidden = false;
}).catch(() => {});
