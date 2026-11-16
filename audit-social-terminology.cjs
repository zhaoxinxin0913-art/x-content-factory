// Read-only public repository research. Does not change the live glossary.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const api = endpoint => execFileSync('gh', ['api', endpoint, '-H', 'Accept: application/vnd.github.raw+json'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'translation-glossary-ko-zhTW-msMY.json'), 'utf8'));
const mapping = [
  ['Follow', 'account.follow', 'follow'], ['Following', 'account.following', 'following'],
  ['Followers', 'account.followers', 'followers'], ['Unfollow', 'account.unfollow', 'unfollow'],
  ['Block', 'account.block', 'block'], ['Unblock', 'account.unblock', 'unblock'],
  ['Mute Account', 'account.mute', 'mute'], ['Unmute Account', 'account.unmute', 'unmute'],
  ['Profile', 'account.edit_profile', 'profile'], ['Notification', 'notifications.column_settings.alert', 'notifications'],
  ['Search', 'search.search_or_paste', 'search'], ['Post', 'compose_form.publish', 'note'],
];
const pins = {};
for (const repo of ['mastodon/mastodon', 'misskey-dev/misskey']) {
  const info = JSON.parse(api(`repos/${repo}`));
  pins[repo] = JSON.parse(api(`repos/${repo}/commits/${info.default_branch}`)).sha;
}
const evidence = [];
for (const [repo, files] of [
  ['mastodon/mastodon', [['en', 'en'], ['ko-KR', 'ko'], ['zh-TW', 'zh-TW'], ['ms-MY', 'ms']]],
  ['misskey-dev/misskey', [['en', 'en-US'], ['ko-KR', 'ko-KR'], ['zh-TW', 'zh-TW']]],
]) {
  const dictionaries = {};
  for (const [locale, file] of files) {
    const relative = repo.startsWith('mastodon') ? `app/javascript/mastodon/locales/${file}.json` : `locales/${file}.yml`;
    const raw = api(`repos/${repo}/contents/${relative}?ref=${pins[repo]}`);
    const dict = repo.startsWith('mastodon') ? JSON.parse(raw) : Object.fromEntries(raw.split('\n').flatMap(line => {
      const m = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*"(.*)"\s*$/);
      if (!m) return [];
      try { return [[m[1], JSON.parse('"' + m[2] + '"')]]; } catch { return []; }
    }));
    dictionaries[locale] = { dict, url: `https://github.com/${repo}/blob/${pins[repo]}/${relative}`, sourceLocale: file };
  }
  for (const [concept, mastodonKey, misskeyKey] of mapping) {
    const key = repo.startsWith('mastodon') ? mastodonKey : misskeyKey;
    const current = seed.lockedTerms.find(t => t.en === concept);
    for (const locale of ['ko-KR', 'zh-TW', 'ms-MY']) {
      const entry = dictionaries[locale];
      if (!entry || !entry.dict[key]) continue;
      evidence.push({ concept, locale, current: current?.[locale] || '', project: repo, key,
        source: dictionaries.en.dict[key] || '', reference: entry.dict[key], sourceLocale: entry.sourceLocale,
        url: entry.url, status: current?.[locale] === entry.dict[key] ? '字面一致，仍需场景核对' : '差异供审阅，不自动替换',
        note: ['Profile', 'Notification', 'Search', 'Post'].includes(concept)
          ? '相近场景样本：可能是动作或描述，不能按同义词直接替换。'
          : locale === 'ms-MY' ? '来源为 ms 通用马来语，未经 ms-MY 母语确认。' : '来源包含变量时按完整文案比较，差异不等于翻译错误。' });
    }
  }
}
const report = { date: '2026-11-16', pins, evidence,
  scope: '12 个通用社交概念的初步交叉对照；不覆盖金币、钻石、麦位、会员机制；社区译文不是 POPUP 核准译法。',
  pending: ['Off Mic 原韩语和马来语候选混淆下麦与关闭麦克风，已撤回，待母语确认。', 'Skin 的马来语候选 Tema 暂撤回，需按装扮/主题机制确认。', 'Moderator 需确认是房间管理员还是内容版主。'],
};
fs.writeFileSync(path.join(__dirname, 'translation-reference-audit.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ entries: evidence.length, concepts: mapping.length, pins }));
