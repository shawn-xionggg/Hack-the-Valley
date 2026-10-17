/** Three short tones for a new alert. Browsers allow audio here because the operator has already clicked. */
export function chime(): void {
  try {
    const audio = new AudioContext();
    [880, 660, 880].forEach((frequency, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = frequency;
      gain.gain.value = 0.18;
      osc.connect(gain).connect(audio.destination);
      osc.start(audio.currentTime + i * 0.22);
      osc.stop(audio.currentTime + i * 0.22 + 0.18);
    });
    setTimeout(() => void audio.close(), 1000);
  } catch { /* No audio device: the pulsing alert still shows. */ }
}
