export function isStrongLegalBoilerplateText(value: string): boolean {
  return /ICP|ICP备|icp|公网安备|备案号?|网站备案|beian|营业执照|增值电信|网络文化经营|网械平台备|互联网药品信息服务|copyright|©|all rights reserved/i.test(value);
}

export function isLegalBoilerplateText(value: string): boolean {
  return isStrongLegalBoilerplateText(value)
    || /privacy policy|terms of (use|service)|隐私政策|用户协议|使用条款|儿童\/青少年个人信息保护规则/i.test(value);
}

export function isCookieConsentText(value: string): boolean {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return /(?:^|\b)(?:this|we|our|site|website)\s+(?:web)?site?\s+uses?\s+cookies?\b/i.test(normalized)
    || /\b(?:we|this\s+(?:web)?site|our\s+(?:web)?site)\s+use\s+cookies?\b/i.test(normalized)
    || /\b(?:verwenden|nutzen|utilizamos|usamos|utilisons|utilizziamo|gebruiken|używamy|používáme|使用|利用|사용)\b.{0,48}\b(?:cookies?|cookie|쿠키|クッキー)\b/i.test(normalized)
    || /\b(?:cookiebot|onetrust|didomi|usercentrics|trustarc|quantcast|consent\s+management|privacy\s+preferences|cookie\s+(?:policy|settings|preferences|notice|banner|consent))\b/i.test(normalized)
    || /\b(?:accept|allow|agree|reject|decline|manage|save|confirm)\s+(?:all\s+)?cookies?\b/i.test(normalized)
    || /\b(?:personalize|personalise)\s+content\b.*\b(?:analy[sz]e|measure)\s+traffic\b/i.test(normalized)
    || /\b(?:gdpr|ccpa|eprivacy)\b.*\b(?:consent|cookies?|privacy)\b/i.test(normalized)
    || /(?:datenschutz|einwilligung|zustimmen|akzeptieren|alle akzeptieren|cookie-einstellungen|privacidad|aceptar(?: todo)?|configurar cookies|confidentialit[eé]|tout accepter|param[eè]tres des cookies|riservatezza|accetta(?: tutto)?|preferenze cookie|privacidade|aceitar(?: tudo)?|prefer[eê]ncias de cookies|toestemming|akkoord|cookies accepteren|samtycke|godkänn|acceptera alla|hyväksy|eväste|zgoda|zaakceptuj|akceptuj|souhlas|přijmout|súhlas|prijať|prihvati|kolačići|колачи|куки|プライバシー|クッキー|同意する|すべて受け入れる|개인정보|쿠키|동의|隐私|隱私|接受全部|同意使用|Cookie 设置|Cookie 設定)/i.test(normalized);
}

export function isWeakBoilerplateText(value: string): boolean {
  return /about\s+baidu|百度首页|使用百度前必读|意见反馈|帮助中心|隐私|条款|关于我们|联系我们|帮助中心|客服|登录|注册|创作中心|业务合作/i.test(value);
}

export function isFooterLikeSelector(value: string): boolean {
  return /(footer|bottom|copyright|beian|icp|contentinfo|record|filing)/i.test(value);
}
