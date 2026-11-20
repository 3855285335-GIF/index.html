// 只在内存中保存本次设置。地点、好友和路线文本均不交给远程语音服务。
function createNavigationSound(beforeSound) {
  const byId = (id) => document.getElementById(id);
  const dialog = byId('sound-dialog');
  let mode = 'off', audio = null, utterance = null, sequence = 0, closed = false;
  function stop() {
    ++sequence;
    if (utterance) {
      utterance.onerror = utterance.onend = null;
      utterance = null;
      window.speechSynthesis?.cancel();
    }
    if (audio) { audio.pause(); audio.currentTime = 0; }
  }
  function tone(message, target, seq) {
    if (seq !== sequence || closed || document.hidden) return;
    try {
      audio ||= new Audio('vendor/navigation-cue.wav');
      audio.currentTime = 0;
      const result = audio.play();
      target.textContent = message;
      result?.catch(() => {
        if (seq === sequence) target.textContent = '设备未播放提示音，可点「试听提示音」再试。';
      });
    } catch {
      target.textContent = '当前设备无法播放提示音。';
    }
  }
  function play(kind, message, target) {
    if (closed || document.hidden || kind === 'off') return;
    stop();
    if (!beforeSound()) {
      target.textContent = '通话或录音期间，导航只显示文字。';
      return;
    }
    const seq = sequence;
    if (kind === 'tone') {
      tone('正在播放提示音。', target, seq);
      return;
    }
    const synth = window.speechSynthesis;
    const voices = (synth?.getVoices() || []).filter((v) => v.localService && /^(?:cmn(?:[-_]|$)|zh(?:$|[-_](?:CN|SG|Hans|TW)(?:[-_]|$)))/i.test(v.lang));
    const voice = voices.find((v) => /^zh[-_]CN$/i.test(v.lang)) || voices[0];
    if (!voice || typeof window.SpeechSynthesisUtterance !== 'function') {
      tone('设备未提供本机普通话语音，已改用提示音。', target, seq);
      return;
    }
    try {
      const u = new SpeechSynthesisUtterance(message);
      utterance = u;
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = 1;
      u.onend = () => { if (seq === sequence) utterance = null; };
      u.onerror = (event) => {
        if (seq !== sequence) return;
        utterance = null;
        if (!['interrupted','canceled'].includes(event.error)) tone('语音暂时无法播放，已改用提示音。', target, seq);
      };
      target.textContent = message;
      synth.speak(u);
    } catch {
      tone('语音暂时无法播放，已改用提示音。', target, seq);
    }
  }
  const sample = '这是 Chatter 导航的声音。算好路线后，你会听到预计用时和距离。';
  const status = byId('sound-status');
  byId('open-sound').onclick = () => {
    window.speechSynthesis?.getVoices();
    status.textContent = '';
    dialog.showModal();
  };
  byId('close-sound').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { stop(); });
  byId('sound-options').onchange = (e) => {
    mode = e.target.value;
    stop();
    byId('sound-label').textContent = mode === 'off' ? '声音' : mode === 'voice' ? '语音开' : '提示音开';
    byId('open-sound').setAttribute('aria-label', { off: '导航声音，当前静音', tone: '导航声音，提示音已开启', voice: '导航声音，中文播报已开启' }[mode]);
    status.textContent = '已静音。';
    if (mode !== 'off') play(mode, sample, status);
  };
  byId('try-sound').onclick = () => play('tone', '', status);
  byId('try-voice').onclick = () => play('voice', sample, status);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  return {
    announce(message, target) { play(mode, message, target); },
    read(message, target) { play('voice', message, target); },
    stop,
    dispose() { closed = true; stop(); }
  };
}
