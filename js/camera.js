// Camera module — getUserMedia for iOS Safari, capture a still frame
export class Camera {
  constructor(videoEl, canvasEl) {
    this.video = videoEl;
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.stream = null;
    this.active = false;
  }

  async start() {
    if (this.active) return;
    const constraints = {
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 960 },
      },
      audio: false,
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.video.srcObject = this.stream;
      // iOS Safari requires playsinline + muted for autoplay
      this.video.setAttribute('playsinline', '');
      this.video.setAttribute('autoplay', '');
      this.video.muted = true;
      await this.video.play();
      this.active = true;
    } catch (err) {
      console.error('Camera access failed:', err);
      throw err;
    }
  }

  capture() {
    if (!this.active) return null;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    this.canvas.width = vw;
    this.canvas.height = vh;
    this.ctx.drawImage(this.video, 0, 0, vw, vh);
    return { width: vw, height: vh };
  }

  stop() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
    }
    this.stream = null;
    this.active = false;
    this.video.srcObject = null;
  }
}
