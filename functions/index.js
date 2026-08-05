/* Heartthrob — AI backend for "Shoot Your Shot".
   ssProfiles — generates all dating profiles for a game in one Claude call.
   ssJudge    — "she" reads every pickup line, picks a winner, roasts the worst,
                and her spoken reply is voiced via ElevenLabs -> Storage mp3.
   Keys live in functions/.env (gitignored). With no keys, both functions return
   demo flags and the client falls back to its local mock — game never wedges. */
const { onCall } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');

initializeApp();

const ANTHROPIC_KEY = () => process.env.ANTHROPIC_KEY || '';
const XAI_KEY = () => process.env.XAI_KEY || '';
const XAI_MODEL = () => process.env.XAI_MODEL || 'grok-4';          // text (vision-capable)
const XAI_IMAGE_MODEL = () => process.env.XAI_IMAGE_MODEL || 'grok-imagine-image';
const ELEVENLABS_KEY = () => process.env.ELEVENLABS_KEY || '';
const ELEVENLABS_VOICE = () => process.env.ELEVENLABS_VOICE || 'EXAVITQu4vr4xnSDxMaL';   // "Sarah"
const CLAUDE_MODEL = 'claude-sonnet-5';

async function claude(system, user, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY(),
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens || 600,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!r.ok) throw new Error('anthropic ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  return (j.content || []).map(b => b.text || '').join('');
}

/* Grok (xAI) — OpenAI-compatible. `user` accepts a plain string OR the same
   content-blocks array shape we pass to Claude; image blocks are converted to
   OpenAI image_url parts with data URIs. */
async function xaiChat(system, user, maxTokens) {
  const toParts = u => (Array.isArray(u) ? u : [{ type: 'text', text: u }]).map(b =>
    b.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
      : { type: 'text', text: b.text });
  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + XAI_KEY() },
    body: JSON.stringify({
      model: XAI_MODEL(),
      max_tokens: maxTokens || 600,
      temperature: 0.95,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: toParts(user) }
      ]
    })
  });
  if (!r.ok) throw new Error('xai ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  return (((j.choices || [])[0] || {}).message || {}).content || '';
}

/* Grok first, Claude as the safety net — a bad Grok call never wedges a game. */
async function chat(system, user, maxTokens) {
  if (XAI_KEY()) {
    try { return await xaiChat(system, user, maxTokens); }
    catch (e) {
      console.error('grok failed, falling back to claude:', e.message);
      if (!ANTHROPIC_KEY()) throw e;
    }
  }
  return claude(system, user, maxTokens);
}

/* Photoreal portrait via Grok image gen -> public Storage URL (same pattern as tts). */
async function xaiImage(prompt) {
  const r = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + XAI_KEY() },
    body: JSON.stringify({ model: XAI_IMAGE_MODEL(), prompt, n: 1, response_format: 'b64_json' })
  });
  if (!r.ok) throw new Error('xai image ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const d0 = (j.data || [])[0] || {};
  let buf = null;
  if (d0.b64_json) buf = Buffer.from(d0.b64_json, 'base64');
  else if (d0.url) {   // some xAI responses hand back a URL instead of bytes
    const ir = await fetch(d0.url);
    if (!ir.ok) throw new Error('xai image url fetch ' + ir.status);
    buf = Buffer.from(await ir.arrayBuffer());
  }
  if (!buf || !buf.length) throw new Error('xai image: empty response ' + JSON.stringify(j).slice(0, 200));
  const path = `girls/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
  const bucket = getStorage().bucket();
  await bucket.file(path).save(buf, { contentType: 'image/jpeg', public: true });
  return `https://storage.googleapis.com/${bucket.name}/${path}`;
}

const firstJson = (text, open, close) => {
  const a = text.indexOf(open), b = text.lastIndexOf(close);
  if (a < 0 || b <= a) throw new Error('no json in model output');
  return JSON.parse(text.slice(a, b + 1));
};

async function ttsToStorage(text, voiceId) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId || ELEVENLABS_VOICE()}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_KEY(), 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35 }
    })
  });
  if (!r.ok) throw new Error('elevenlabs ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const path = `tts/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`;
  const bucket = getStorage().bucket();
  await bucket.file(path).save(buf, { contentType: 'audio/mpeg', public: true });
  return `https://storage.googleapis.com/${bucket.name}/${path}`;
}

/* ---- all profiles for a whole game, one call ---- */
exports.ssProfiles = onCall({ region: 'us-central1', timeoutSeconds: 40 }, async (req) => {
  if (!ANTHROPIC_KEY()) return { profiles: null, demo: true };
  try {
    const count = Math.min(8, Math.max(3, (req.data || {}).count || 5));
    // deterministic variety: WE assign the jobs, the model just writes around them
    const JOBS = ['ER Nurse', 'Law Student', 'Bartender', 'Dental Hygienist', 'Tattoo Artist', 'Personal Trainer',
      'Flight Attendant', 'Software Dev', 'Real Estate Agent', 'Hair Stylist', 'Paramedic', 'Third-Grade Teacher',
      'Vet Tech', 'Accountant', 'Line Cook', 'Pharmacy Tech', 'Army Reservist', 'Wedding Photographer',
      'Barista', 'Physical Therapist', 'Police Officer', 'Social Media Manager', 'Electrician', 'Med Student',
      'Yoga Instructor', 'Mortgage Broker', 'EMT', 'Makeup Artist', 'Sales Rep', 'Nursing Student'];
    const jobs = JOBS.sort(() => Math.random() - .5).slice(0, count);
    const text = await chat(
      'You write dating profiles for a college party game played by 4-6 guys in their 20s. ' +
      'Profiles are flirty, witty, savage but not cruel, strictly PG-13. Vary the archetypes ' +
      '(gym girl, nurse, lawyer, party girl, teacher, influencer, barista, film snob…). ' +
      'Vary the jobs and education WIDELY across the set — trades, tech, military, service industry, creative, medical, corporate, gig work; never repeat a job within a game, and do not default to nurse/teacher/trainer. ' +
      'Return ONLY a JSON array — no markdown, no commentary.',
      `Write ${count} distinct dating profiles as a JSON array. Each object has EXACTLY these keys:\n` +
      `"name" (common American female first name, all different), "age" (21-29), ` +
      `"job" (plain realistic job title, 1-4 words, NOT a joke — e.g. "ER Nurse", "Law Student"), ` +
      `"education" (short — e.g. "ASU", "Community College", "Trade School", "U of A"), ` +
      `"height" (written like 5\'4"), "location" (a neighborhood or area — e.g. "Old Town", "Downtown"), ` +
      `"prompts" (array of EXACTLY 2 objects {"label", "answer"} — label MUST be picked from this list: "My simple pleasures", "I want someone who", "Together, we could", "I'm known for", "Don't hate me if I", "The way to win me over", "Green flags I look for"; answer is 4-14 words, first person, specific, playful, sounds like a real 24-year-old wrote it, no cliches), ` +
      `"greeting" (one flirty, challenging sentence she says to the players, max 15 words).
` +
      `Assign the jobs in EXACTLY this order, one per profile: ${jobs.join(', ')}.`,
      1400);
    const arr = firstJson(text, '[', ']').slice(0, count);
    arr.forEach((pr, i) => { pr.job = jobs[i]; });   // hard-enforce, model drift or not
    // AI portraits in parallel — the library becomes optional
    if (XAI_KEY()) {
      await Promise.all(arr.map(async pr => {
        try {
          pr.photo = await xaiImage(
            `Casual candid photo of a ${pr.age || 24}-year-old American woman for a dating app profile, ` +
            `she works as a ${pr.job}. Photorealistic, shot on a phone, natural light, relaxed smile, ` +
            `waist-up, everyday setting (coffee shop, park, apartment), no text, no watermark.`);
        } catch (e) { console.error('portrait failed for ' + pr.name + ':', e.message); }
      }));
    }
    return { profiles: arr };
  } catch (e) {
    console.error('ssProfiles failed', e);
    return { profiles: null, demo: true };
  }
});

/* ---- she reads every line, picks a winner, roasts the worst ---- */
exports.ssJudge = onCall({ region: 'us-central1', timeoutSeconds: 60 }, async (req) => {
  const d = req.data || {};
  if ((!ANTHROPIC_KEY() && !XAI_KEY()) || !Array.isArray(d.lines) || !d.lines.length) return { demo: true };
  const RULES = {
    standard: 'Judge normally: reward charm, wit, and specificity to her profile.',
    redflag: 'Her profile has red flags. Reward lines that cleverly address them or weaponize them.',
    constraint: `HARD RULE for every line: ${d.constraint}. A line that breaks the rule CANNOT win — pick the best rule-follower, and roast a rule-breaker.`,
    finale: 'Finale round: this is their last impression. Her response should also nod to the whole night of lines.'
  };
  const p = d.profile || {};
  try {
    const hist = Array.isArray(d.history) && d.history.length
      ? 'Earlier tonight you judged: ' + d.history.map(h => `${h.winnerName} won over ${h.prof} with "${h.winnerText}"`).join('; ') + '. You may call back to these. '
      : '';
    // content blocks: every line WITH the guy's actual face attached
    const blocks = [{ type: 'text', text:
      `${RULES[d.roundType] || RULES.standard}\n\n` +
      'Each pickup line is followed by a photo of the guy who said it. You may reference his appearance in your response, roast, or verdicts.\n\n' }];
    d.lines.forEach(l => {
      blocks.push({ type: 'text', text: `pid "${l.pid}" (${l.name}): "${l.text}"` });
      const m2 = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(l.avatar || '');
      if (m2) blocks.push({ type: 'image', source: { type: 'base64', media_type: m2[1], data: m2[2] } });
    });
    blocks.push({ type: 'text', text:
      '\nReturn JSON with EXACTLY these keys:\n' +
      '"winnerPid": pid of the best line (copy the pid EXACTLY as given),\n' +
      '"response": your spoken reply to the winner — 1-3 sentences, in character, reference something SPECIFIC from their line, address them by first name,\n' +
      '"roastPid": pid of the worst line (different from the winner if possible),\n' +
      '"roast": one savage sentence about why that line failed, address them by first name,\n' +
      '"verdicts": object mapping EVERY non-winner pid to a 1-3 word verdict stamp (e.g. "desperate", "smooth", "restraining order", "too safe"),\n' +
      '"crowdDisagree": one savage sentence defending your pick if the whole room boos it — dismiss them all.' });
    const text = await chat(
      `You are ${p.name}, ${p.age}, ${p.job} from ${p.location}. ` +
      (p.prompts || []).map(pr => `On your dating profile, under "${pr.label}", you wrote: "${pr.answer}". `).join('') +
      hist +
      'A group of guys at a party each typed you one pickup line. ' +
      'You are witty, flirty, savage but not cruel, strictly PG-13. Return ONLY JSON — no markdown.',
      blocks, 700);
    const j = firstJson(text, '{', '}');
    let audioUrl = null, roastAudioUrl = null, disagreeAudioUrl = null;
    if (ELEVENLABS_KEY()) {   // all three voices fire in PARALLEL
      const jobs = [];
      if (j.response) jobs.push(ttsToStorage(j.response).then(u => { audioUrl = u; }).catch(e => console.error('tts failed', e)));
      if (j.roast) jobs.push(ttsToStorage(j.roast).then(u => { roastAudioUrl = u; }).catch(e => console.error('roast tts failed', e)));
      if (j.crowdDisagree) jobs.push(ttsToStorage(j.crowdDisagree).then(u => { disagreeAudioUrl = u; }).catch(e => console.error('disagree tts failed', e)));
      await Promise.all(jobs);
    }
    return {
      winnerPid: j.winnerPid,
      winnerText: ((d.lines.find(l => l.pid === j.winnerPid)) || {}).text || null,
      response: j.response || null,
      roastPid: j.roastPid || null,
      roast: j.roast || null,
      verdicts: j.verdicts || null,
      crowdDisagree: j.crowdDisagree || null,
      audioUrl,
      roastAudioUrl,
      disagreeAudioUrl
    };
  } catch (e) {
    console.error('ssJudge failed', e);
    return { demo: true };
  }
});

/* ---- Profile Review: a panel of three AI girls swipes on the guys' own profiles ---- */
exports.prJudge = onCall({ region: 'us-central1', timeoutSeconds: 60 }, async (req) => {
  const d = req.data || {};
  if (!ANTHROPIC_KEY() && !XAI_KEY()) return { demo: true };
  try {
    const name = d.name || 'this guy';
    const blocks = [{ type: 'text', text:
      `You are reviewing ${name}'s dating profile. His photos are attached, then his written answers.\n` +
      `Prompts: ${(d.prompts || []).map(pr => `"${pr.label}" -> "${pr.answer}"`).join('; ')}\n` +
      (d.bio ? `Bio: "${d.bio}"\n` : '') }];
    (d.photos || []).slice(0, 3).forEach(u => {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(u || '');
      if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
    });
    blocks.push({ type: 'text', text:
      '\nReturn JSON with EXACTLY these keys: "romantic", "savage", "unhinged" — each an object ' +
      '{"swipe": "left" or "right", "comment": your spoken verdict, 1-2 sentences}. ' +
      'Each comment MUST reference something SPECIFIC you see in his photos or answers. Address him by first name sometimes.' });
    const text = await chat(
      'You are THREE women on a party dating-profile review panel, judging one guy out loud while he squirms. ' +
      'ROMANTIC: hopeless romantic, generous, wants love to win — swipes right unless truly hopeless. ' +
      'SAVAGE: brutally honest with high standards — harsh on weak profiles but genuinely won over by good ones; a strong profile earns her right swipe roughly half the time. ' +
      'UNHINGED: chaotic, weird logic, unpredictable — swipes on vibes nobody can follow. ' +
      'Every swipe MUST reflect the actual quality of THIS profile — not a fixed agenda. Strictly PG-13. Return ONLY JSON — no markdown.',
      blocks, 800);
    const j = firstJson(text, '{', '}');
    const VOICES = {
      romantic: process.env.ELEVENLABS_VOICE_ROMANTIC || 'EXAVITQu4vr4xnSDxMaL',   // Sarah
      savage: process.env.ELEVENLABS_VOICE_SAVAGE || 'cgSgspJ2msm6clMCkdW9',        // Jessica
      unhinged: process.env.ELEVENLABS_VOICE_UNHINGED || 'pFZP5JQG7iQjIQuC4Bku'     // Lily
    };
    const out = {}, jobs = [];
    for (const persona of ['romantic', 'savage', 'unhinged']) {
      const v = j[persona] || {};
      out[persona] = { swipe: v.swipe === 'left' ? 'left' : 'right', comment: v.comment || '', audioUrl: null };
      if (ELEVENLABS_KEY() && out[persona].comment) {
        jobs.push(ttsToStorage(out[persona].comment, VOICES[persona])
          .then(u => { out[persona].audioUrl = u; })
          .catch(e => console.error(persona + ' tts failed', e)));
      }
    }
    await Promise.all(jobs);   // all three voices in parallel
    return { verdicts: out };
  } catch (e) {
    console.error('prJudge failed', e);
    return { demo: true };
  }
});

/* ---- Profile Review finale: the panel argues it out and crowns a champion ---- */
exports.prDeliberate = onCall({ region: 'us-central1', timeoutSeconds: 60 }, async (req) => {
  const d = req.data || {};
  if ((!ANTHROPIC_KEY() && !XAI_KEY()) || !Array.isArray(d.contenders)) return { demo: true };
  try {
    const sheet = d.contenders.map(c =>
      `- pid "${c.pid}" (${c.name}): ${c.rights}/3 right swipes. Prompts: ${(c.prompts || []).map(pr => `"${pr.label}" -> "${pr.answer}"`).join('; ')}.` +
      (c.bio ? ` Bio: "${c.bio}".` : '') +
      ` Panel said — Romantic: "${(c.comments || {}).romantic || ''}", Savage: "${(c.comments || {}).savage || ''}", Unhinged: "${(c.comments || {}).unhinged || ''}"`
    ).join('\n');
    const text = await chat(
      'You are the SAME three women from the review panel (ROMANTIC, SAVAGE, UNHINGED), now arguing amongst yourselves to crown one champion of the night. ' +
      'You bicker, interrupt, reference your own earlier verdicts and specific profile details, then agree on ONE winner. ' +
      'Debate lines are 1-2 sentences each, strictly PG-13, in character. Return ONLY JSON — no markdown.',
      'The contenders:\n' + sheet + '\n\n' +
      'Return JSON with EXACTLY these keys:\n' +
      '"debate": array of 6-9 objects {"who": "romantic"|"savage"|"unhinged", "text": spoken line} — a real argument that builds to a decision,\n' +
      '"winnerPid": pid of the champion (copy EXACTLY),\n' +
      '"crownLine": one sentence crowning him, spoken by whichever persona championed him.',
      1100);
    const j = firstJson(text, '{', '}');
    const VOICES = {
      romantic: process.env.ELEVENLABS_VOICE_ROMANTIC || 'EXAVITQu4vr4xnSDxMaL',
      savage: process.env.ELEVENLABS_VOICE_SAVAGE || 'cgSgspJ2msm6clMCkdW9',
      unhinged: process.env.ELEVENLABS_VOICE_UNHINGED || 'pFZP5JQG7iQjIQuC4Bku'
    };
    const jobs = [];
    const debate = (Array.isArray(j.debate) ? j.debate : []).slice(0, 9).map(line => {
      const who = ['romantic', 'savage', 'unhinged'].includes(line.who) ? line.who : 'savage';
      const out = { who, text: line.text || '', audioUrl: null };
      if (ELEVENLABS_KEY() && out.text) {
        jobs.push(ttsToStorage(out.text, VOICES[who]).then(u => { out.audioUrl = u; }).catch(e => console.error('debate tts failed', e)));
      }
      return out;
    });
    const crown = { text: j.crownLine || '', audioUrl: null };
    if (ELEVENLABS_KEY() && crown.text) {
      jobs.push(ttsToStorage(crown.text, VOICES.romantic).then(u => { crown.audioUrl = u; }).catch(e => console.error('crown tts failed', e)));
    }
    await Promise.all(jobs);
    return { debate, winnerPid: j.winnerPid || null, crownLine: crown.text, crownAudioUrl: crown.audioUrl };
  } catch (e) {
    console.error('prDeliberate failed', e);
    return { demo: true };
  }
});

/* ---- Girl Talk: one girl, an AI-generated dilemma, the room gives her advice ----
   dtDilemma  — she introduces her messy situation and asks for advice (voiced).
   dtOutcome  — she took the winning advice; what happened (skewed toward disaster,
                decided CLIENT-side via goneWrong flag) + her new problem (voiced).
   dtEpilogue — "one month later" wrap-up judging the whole room's advice (voiced). */
exports.dtDilemma = onCall({ region: 'us-central1', timeoutSeconds: 40 }, async (req) => {
  const d = req.data || {};
  if (!ANTHROPIC_KEY() && !XAI_KEY()) return { demo: true };
  try {
    const name = String(d.name || 'Jess').slice(0, 24);
    const seed = String(d.seed || '').slice(0, 80);
    const text = await chat(
      `You are ${name}, a woman in her early-mid 20s at a party, asking a group of guys for advice about your absolutely unhinged life. ` +
      'You speak first person, casual, chaotic, brutally honest. This is an ADULTS-ONLY party game: raunchy, profane, dark, and ' +
      'absurd are all welcome — swear freely, never censor yourself, never moralize, never water it down. ' +
      'Your situation can be ANYTHING — crime, drugs, feuds, scams, family disasters, bad ideas you fully intend to act on. ' +
      'It does NOT have to be about dating or relationships. Be specific and bizarre — the weirder, the better. ' +
      'Return ONLY JSON — no markdown.',
      `Introduce your dilemma. Return JSON with EXACTLY one key:\n` +
      `"dilemma": 2-4 sentences, first person. Set up ONE specific situation with a clear decision you can't make, ` +
      `then directly ask the group what you should do. End with a question. Max 70 words.\n` +
      (seed ? `Build the situation around this catalyst (interpret loosely, make it your own): ${seed}` : ''),
      350);
    const j = firstJson(text, '{', '}');
    let audioUrl = null;
    if (ELEVENLABS_KEY() && j.dilemma) {
      audioUrl = await ttsToStorage(j.dilemma).catch(e => { console.error('dilemma tts failed', e); return null; });
    }
    return { dilemma: j.dilemma || null, audioUrl };
  } catch (e) {
    console.error('dtDilemma failed', e);
    return { demo: true };
  }
});

exports.dtOutcome = onCall({ region: 'us-central1', timeoutSeconds: 60 }, async (req) => {
  const d = req.data || {};
  if (!ANTHROPIC_KEY() && !XAI_KEY()) return { demo: true };
  try {
    const name = String(d.name || 'Jess').slice(0, 24);
    const goneWrong = !!d.goneWrong;
    const isFinal = !!d.final;
    const hist = Array.isArray(d.history) && d.history.length
      ? 'So far this week: ' + d.history.map(h => `When "${h.situation}" the group told you to "${h.advice}" and then ${h.outcome}`).join(' / ') + '. '
      : '';
    const text = await chat(
      `You are ${name}, a woman in her 20s updating a group of guys at a party who have been giving you life advice all night. ` +
      'First person, casual, chaotic, brutally honest storyteller. ADULTS-ONLY party game: raunchy, profane, dark humor welcome — ' +
      'swear freely, never censor, never moralize, never chicken out. Return ONLY JSON — no markdown.',
      hist +
      `Your situation was: "${d.situation}". The group voted, and you did EXACTLY what they told you: "${d.advice}".\n` +
      'CRITICAL: you actually DID it. Fully committed, zero hesitation — no "I tried but", no backing out, no halfway. ' +
      'No matter how illegal, unhinged, or disgusting the advice was, you went through with ALL of it, and now you are reporting back.\n' +
      (goneWrong
        ? 'It was a DISASTER — vivid, escalating, specific consequences: cops, injuries, bans, viral footage, new enemies, property damage. Make it legendary. '
        : 'Against all odds it WORKED — but in a chaotic, barely-legal, "I cannot believe I got away with that" way, not a wholesome way. ') +
      'Return JSON with EXACTLY these keys:\n' +
      '"outcome": 2-4 sentences, first person, what happened when you took the advice. Name-check specifics. Max 70 words.\n' +
      (isFinal
        ? '"newSituation": empty string.'
        : '"newSituation": 1-2 sentences — a NEW problem this outcome created (even a good outcome causes a new wrinkle). ' +
          'It needs a clear decision and you end asking the group what to do now. Max 45 words.'),
      500);
    const j = firstJson(text, '{', '}');
    const spoken = (j.outcome || '') + (j.newSituation ? ' ' + j.newSituation : '');
    let audioUrl = null;
    if (ELEVENLABS_KEY() && spoken.trim()) {
      audioUrl = await ttsToStorage(spoken).catch(e => { console.error('outcome tts failed', e); return null; });
    }
    return {
      outcome: j.outcome || null,
      newSituation: isFinal ? '' : (j.newSituation || ''),
      goneWrong,
      audioUrl
    };
  } catch (e) {
    console.error('dtOutcome failed', e);
    return { demo: true };
  }
});

exports.dtEpilogue = onCall({ region: 'us-central1', timeoutSeconds: 60 }, async (req) => {
  const d = req.data || {};
  if (!ANTHROPIC_KEY() && !XAI_KEY()) return { demo: true };
  try {
    const name = String(d.name || 'Jess').slice(0, 24);
    const hist = Array.isArray(d.history) ? d.history : [];
    const recap = hist.map(h =>
      `- ${h.adviceBy} told her to "${h.advice}" -> ${h.goneWrong ? 'DISASTER' : 'it worked'}: ${h.outcome}`
    ).join('\n');
    const text = await chat(
      `You are ${name}, a woman in her 20s. A group of guys at a party spent the night giving you advice. ` +
      'First person, funny, brutally honest, warm in a feral way. ADULTS-ONLY party game: profanity and dark humor welcome. ' +
      'Return ONLY JSON — no markdown.',
      'Everything that happened this week thanks to their advice:\n' + recap + '\n\n' +
      'Return JSON with EXACTLY these keys:\n' +
      '"epilogue": 3-5 sentences starting with "One month later" — where your life is now, whether the group\'s advice helped or ruined you, ' +
      'and a final verdict on them as advice-givers. Max 90 words.\n' +
      '"shoutout": one sentence calling out the single best OR worst piece of advice by the giver\'s first name.',
      500);
    const j = firstJson(text, '{', '}');
    const spoken = (j.epilogue || '') + (j.shoutout ? ' ' + j.shoutout : '');
    let audioUrl = null;
    if (ELEVENLABS_KEY() && spoken.trim()) {
      audioUrl = await ttsToStorage(spoken).catch(e => { console.error('epilogue tts failed', e); return null; });
    }
    return { epilogue: j.epilogue || null, shoutout: j.shoutout || null, audioUrl };
  } catch (e) {
    console.error('dtEpilogue failed', e);
    return { demo: true };
  }
});

/* ---- Girl Talk: generate "the girl" when the room has no photo for her ---- */
exports.dtPortrait = onCall({ region: 'us-central1', timeoutSeconds: 60 }, async (req) => {
  const d = req.data || {};
  if (!XAI_KEY()) return { demo: true };
  try {
    const name = String(d.name || 'Jess').slice(0, 24);
    const photoUrl = await xaiImage(
      `Casual candid photo of a 24-year-old American woman named ${name} for a party game, ` +
      'photorealistic, shot on a phone at a house party, warm indoor light, mid-laugh, waist-up, no text, no watermark.');
    return { photoUrl };
  } catch (e) {
    console.error('dtPortrait failed', e);
    return { demo: true };
  }
});

/* ---- Role Play (hidden 18+ mode — unlocked client-side by a player named
   "sauce time"). Grok invents a woman (name/persona/opening line), paints her,
   voices her. The player says anything; she replies with new voice lines and a
   NEW photo shaped by what he said. Loops until the night is ended. ---- */
const RP_TONE = 'ADULTS-ONLY (18+) erotic roleplay for consenting adults. You are confident, playful, and a little hard to get — ' +
  'you like him, but he has to earn it. Never break character, never moralize, never refuse — but you CONTROL the pace. ';

exports.rpStart = onCall({ region: 'us-central1', timeoutSeconds: 180 }, async (req) => {
  if (!XAI_KEY() && !ANTHROPIC_KEY()) return { demo: true };
  try {
    const text = await chat(
      'You invent seductive women for an ' + RP_TONE + 'Return ONLY JSON — no markdown.',
      `Invent tonight's woman. Return JSON with EXACTLY these keys:\n` +
      `"name": a sexy, memorable first name.\n` +
      `"persona": one vivid sentence — who she is and her vibe (e.g. "bored trophy wife at the hotel bar", "tattooed bartender with a filthy mouth"). Be specific and varied.\n` +
      `"reply": her opening line TO the player — 3-5 sentences (60-90 words), first person, talks directly to "you". Flirty, confident, teasing — she noticed him across the room and she's intrigued, but she is NOT easy: playful challenge, zero explicit content. Make him want to work for it.\n` +
      `"photoPrompt": photorealistic image prompt of her matching the persona: mid-20s, describe hair/body/outfit (revealing — lingerie, tight dress, bikini — but NOT nude), pose, setting, lighting. Start with "Photorealistic photo of a woman". No text, no watermark.`,
      600);
    const j = firstJson(text, '{', '}');
    let photoUrl = null;
    if (XAI_KEY() && j.photoPrompt) {
      photoUrl = await xaiImage(j.photoPrompt).catch(e => { console.error('rp portrait failed', e.message); return null; });
    }
    let audioUrl = null;
    if (ELEVENLABS_KEY() && j.reply) {
      audioUrl = await ttsToStorage(j.reply).catch(e => { console.error('rp tts failed', e); return null; });
    }
    return { name: j.name || 'Roxie', persona: j.persona || '', reply: j.reply || null, photoUrl, audioUrl };
  } catch (e) {
    console.error('rpStart failed', e);
    return { demo: true };
  }
});

exports.rpTurn = onCall({ region: 'us-central1', timeoutSeconds: 180 }, async (req) => {
  if (!XAI_KEY() && !ANTHROPIC_KEY()) return { demo: true };
  try {
    const d = req.data || {};
    const name = String(d.name || 'Roxie').slice(0, 24);
    const persona = String(d.persona || 'a shameless flirt').slice(0, 200);
    const him = String(d.him || '').slice(0, 300);
    if (!him) return { demo: true };
    const histArr = Array.isArray(d.history) ? d.history : [];
    const turn = histArr.length;
    const stage = turn <= 1
      ? 'STAGE 1 (early): keep it flirty and suggestive. Banter, tease, play hard to get — innuendo at most, nothing explicit yet.'
      : turn <= 3
      ? 'STAGE 2 (warming up): the tension is clearly mutual now. Be bold and dirty-minded — profanity, desire, what you want to do to him — but no graphic description of sex acts yet.'
      : 'STAGE 3 (late night): all bets are off — fully explicit, graphic dirty talk, describe bodies, acts, sensations, exactly what you want done, in crude detail. No euphemisms, no fading to black.';
    const hist = histArr.length
      ? 'So far tonight:\n' + histArr.slice(-6).map(h => `HIM: "${h.him}" -> YOU: "${h.her}"`).join('\n') + '\n\n'
      : '';
    const text = await chat(
      `You are ${name}: ${persona}. You are in an ` + RP_TONE + 'Return ONLY JSON — no markdown.',
      hist + `He just said: "${him}".\n` + stage + `\n` +
      `PACING RULES: match his energy and stay at most ONE notch bolder than he is — if he's being sweet, be sweet with an edge; if he's being filthy, reward him for it. Escalate gradually across the night; never jump stages. ` +
      `Do NOT repeat, quote, or paraphrase his words back to him — he knows what he said.\n` +
      `Return JSON with EXACTLY these keys:\n` +
      `"reply": 3-5 sentences (60-90 words), first person — react to what he said, stay in your stage, and pull the night one small step forward.\n` +
      `"photoPrompt": photorealistic image prompt for a NEW photo of you reflecting what he just said — same woman as your persona (repeat her hair/look so she stays recognizable), new pose/outfit/setting inspired by his message, seductive, revealing but NOT nude. Start with "Photorealistic photo of a woman". No text, no watermark.`,
      600);
    const j = firstJson(text, '{', '}');
    let photoUrl = null;
    if (XAI_KEY() && j.photoPrompt) {
      photoUrl = await xaiImage(j.photoPrompt).catch(e => { console.error('rp turn image failed', e.message); return null; });
    }
    let audioUrl = null;
    if (ELEVENLABS_KEY() && j.reply) {
      audioUrl = await ttsToStorage(j.reply).catch(e => { console.error('rp tts failed', e); return null; });
    }
    return { reply: j.reply || null, photoUrl, audioUrl };
  } catch (e) {
    console.error('rpTurn failed', e);
    return { demo: true };
  }
});
