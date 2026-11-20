/**
 * Basic Nigerian language support for SMS and USSD: English, Nigerian Pidgin,
 * Yoruba, Hausa and Igbo.
 *
 * Text is plain ASCII on purpose (tone marks and hooked letters are written without
 * diacritics, as most people text): it keeps SMS in the cheap GSM-7 encoding and is
 * valid on every USSD handset. Translations should be reviewed by native speakers
 * before launch; missing keys fall back to English.
 */

export const LOCALES = ['en', 'pcm', 'yo', 'ha', 'ig'] as const;
export type Locale = (typeof LOCALES)[number];

export const LANGUAGE_NAMES: Record<Locale, string> = {
  en: 'English',
  pcm: 'Nigerian Pidgin',
  yo: 'Yoruba',
  ha: 'Hausa',
  ig: 'Igbo',
};

/** Stored value for an explicit English choice ("en" alone is the column default). */
export const EXPLICIT_ENGLISH = 'en-NG';

export function toLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const code = value.trim().toLowerCase().split(/[-_]/)[0]!;
  return (LOCALES as readonly string[]).includes(code) ? (code as Locale) : null;
}

/** A message that is only a language choice: "Yoruba", "LANG HA", "pidgin". */
export function languageChoice(text: string): Locale | null {
  const value = text
    .trim()
    .toLowerCase()
    .replace(/^(?:lang(?:uage)?|ede|harshe|asusu)\s*[:-]?\s*/, '')
    .replace(/[.!]+$/, '');
  if (/^(?:en|eng|english|oyinbo)$/.test(value)) return 'en';
  if (/^(?:pcm|pidgin|pidgin english|naija|broken english)$/.test(value)) return 'pcm';
  if (/^(?:yo|yoruba|yorùbá|ede yoruba)$/.test(value)) return 'yo';
  if (/^(?:ha|hausa|harshen hausa)$/.test(value)) return 'ha';
  if (/^(?:ig|igbo|asusu igbo)$/.test(value)) return 'ig';
  return null;
}

/** Greetings and phrases that clearly show the language someone is writing in. */
export function detectLocale(text: string): Locale | null {
  const value = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  if (/\b(?:bawo|e kaa?ro|ekaaro|e kaasan|e kaale|e nle|se daadaa|mo n saisan|mo ni iba|ori n fo mi)\b/.test(value))
    return 'yo';
  if (/\b(?:sannu|ina kwana|ina wuni|ina yini|barka da|ina da zazzabi|ciwon kai|ina jin ciwo)\b/.test(value))
    return 'ha';
  if (/\b(?:ndewo|kedu|ututu oma|ahu adighi m|isi na-awa m|enwere m ahu oku)\b/.test(value)) return 'ig';
  if (/\b(?:how far|wetin|abeg|dey do me|una|wahala|i no well|body dey hot)\b/.test(value)) return 'pcm';
  return null;
}

type Params = Record<string, string | number>;
type Entry = string | ((params: Params) => string);
type Dictionary = Partial<Record<string, Entry>>;

const en: Record<string, Entry> = {
  help: 'HealthAccess can help. Reply with a number: 1 Find a clinic or hospital, 2 Emergency help, 3 Ask a health question, 4 Get my access code. Or just tell me what is wrong. In danger? Call 112. Reply LANG to change language.',
  greeting:
    'Hi, I am HealthAccess. Tell me what is wrong or what you need, for example "fever since yesterday" or "clinic in Ikeja". Or reply 1 Find care, 2 Emergency, 3 Ask a question, 4 My access code.',
  urgent:
    'This may be an emergency. Get immediate in-person help: call 112 now or go to the nearest emergency department. Reply with your area (e.g. Ikeja) and I will send the nearest emergency hospital, or send EMERGENCY <area>.',
  notLinked:
    'This phone is not linked to a HealthAccess account yet. Sign in on the HealthAccess website, open Channels and verify this number, then reply CODE again.',
  thanks: 'You are welcome. Message me any time you need care or have a health question. In danger? Call 112.',
  askArea: 'Which area or nearby landmark are you in?',
  askEmergencyArea: 'Which area or nearby landmark are you in? Call 112 now if the situation is life-threatening.',
  savedAreaUrgent: (p) =>
    `This may be an emergency: call 112 now or go to the nearest emergency department. Searching near your saved area, ${p.area}. Send EMERGENCY <area> if you are elsewhere.`,
  savedAreaEmergency: (p) =>
    `Searching near your saved area, ${p.area}. Call 112 now if life-threatening. Send EMERGENCY <area> if you are somewhere else.`,
  savedAreaCare: (p) =>
    `Search near ${p.area} (your saved area)? Reply YES, or send the area or landmark you are in now.`,
  whichCare: (p) => `Which care? ${p.options} Reply with a number. I will then ask for your area.`,
  lastEmergency:
    'That was the last emergency option I found. Life-threatening? Call 112 now or go to the nearest emergency department. To search somewhere else, reply EMERGENCY and the area.',
  lastCare: 'That was the last option I found nearby. Reply with another area or landmark and I will search there.',
  noList: 'There is no active result list. Tell me what care you need and where, for example "clinic in Ikeja".',
  askQuestion: 'What would you like to ask? Describe the symptom or question in one message.',
  myCode: (p) =>
    `Your HealthAccess emergency code is ${p.code}. Anyone you give it to can see your emergency information. Reply NEW CODE for a code that expires in 1 hour.`,
  myCodeEmpty: (p) =>
    `Your HealthAccess emergency code is ${p.code}. It shows nothing yet: choose your emergency summary on the HealthAccess website. Reply NEW CODE for a 1-hour code with your emergency details.`,
  newCode: (p) =>
    `Your 1-hour HealthAccess code is ${p.code}. Give it to your doctor or nurse. It opens your emergency information by USSD or on the website.`,
  nothingToShare: 'Add your health information on the HealthAccess website first, then reply NEW CODE.',
  generalInfo: 'This is general information, not a diagnosis.',
  tryAgain: 'Sorry, I could not answer that just now. Please send your message again in a minute, or reply HELP for options. In danger? Call 112.',
  fallback: 'I cannot give a safe answer to that by SMS. Please speak to a health worker or visit the nearest clinic. If this is an emergency, call 112.',
  languageMenu: 'Choose a language: 1 English, 2 Pidgin, 3 Yoruba, 4 Hausa, 5 Igbo. Reply with a number.',
  languageSet: 'Okay, I will reply in English. Tell me what is wrong or what you need.',
  // Listings
  option: 'Option',
  nearestOption: 'Nearest option',
  emergencyOption: 'Emergency',
  nearestEmergency: 'Nearest emergency option',
  call: 'Call',
  noPhone: 'No phone number listed.',
  foundOnline: 'Found online, not checked by us. Call first to confirm they can help.',
  foundOnlineShort: 'Found online, not checked by us.',
  fromDirectory: 'From the HealthAccess directory. Call ahead to check they are open.',
  aboutKm: (p) => `About ${p.km} km away`,
  replyMore: 'Reply MORE for another option.',
  replyMoreEmergency: 'Life-threatening? Call 112 now. Reply MORE for another.',
  emergencyOnly: 'Life-threatening? Call 112 now.',
  searchAgain: 'Reply with another area to search again.',
  sourceNote: 'General information, not a diagnosis or a doctor\'s advice.',
  source: 'Source',
};

const pcm: Dictionary = {
  help: 'HealthAccess fit help you. Reply with number: 1 Find clinic or hospital, 2 Emergency help, 3 Ask health question, 4 Get my access code. Or just tell me wetin dey do you. For danger? Call 112. Reply LANG to change language.',
  greeting:
    'How far! Na HealthAccess be dis. Tell me wetin dey worry you or wetin you need, like "fever since yesterday" or "clinic for Ikeja". Or reply 1 Find clinic, 2 Emergency, 3 Ask question, 4 My code.',
  urgent:
    'Dis one fit be emergency. Find help sharp sharp: call 112 now or go the nearest emergency hospital. Reply with your area (like Ikeja) make I send you the nearest emergency hospital.',
  notLinked:
    'Dis phone never connect to HealthAccess account. Sign in for HealthAccess website, open Channels and verify dis number, then reply CODE again.',
  thanks: 'No wahala. Message me anytime you need care or you get health question. For danger? Call 112.',
  askArea: 'Which area or landmark you dey now?',
  askEmergencyArea: 'Which area or landmark you dey now? If e serious well well, call 112 now.',
  savedAreaUrgent: (p) =>
    `Dis one fit be emergency: call 112 now or go the nearest emergency hospital. I dey search near your area, ${p.area}. Send EMERGENCY <area> if you no dey there.`,
  savedAreaEmergency: (p) =>
    `I dey search near your area, ${p.area}. If e serious, call 112 now. Send EMERGENCY <area> if you dey another place.`,
  savedAreaCare: (p) => `Make I search near ${p.area} (your area)? Reply YES, or send the area wey you dey now.`,
  whichCare: (p) => `Which kain care? ${p.options} Reply with number. After, I go ask your area.`,
  lastEmergency:
    'Na the last emergency place wey I find be dat. If e serious, call 112 now or go the nearest emergency hospital. To search another place, reply EMERGENCY and the area.',
  lastCare: 'Na the last place wey I find near you be dat. Send another area make I search there.',
  noList: 'No list dey now. Tell me wetin you need and where, like "clinic for Ikeja".',
  askQuestion: 'Wetin you wan ask? Talk the sickness or question for one message.',
  myCode: (p) =>
    `Your HealthAccess emergency code na ${p.code}. Anybody wey you give am fit see your emergency info. Reply NEW CODE for code wey go expire after 1 hour.`,
  myCodeEmpty: (p) =>
    `Your HealthAccess emergency code na ${p.code}. E never show anything: choose your emergency summary for HealthAccess website. Reply NEW CODE for 1-hour code.`,
  newCode: (p) =>
    `Your 1-hour HealthAccess code na ${p.code}. Give your doctor or nurse. E go open your emergency info for USSD or website.`,
  nothingToShare: 'First add your health info for HealthAccess website, then reply NEW CODE.',
  generalInfo: 'Dis na general information, no be diagnosis.',
  tryAgain: 'Sorry, I no fit answer am now. Abeg send your message again after small time, or reply HELP. For danger? Call 112.',
  fallback: 'I no fit give correct answer for dis one by SMS. Abeg see health worker or go the nearest clinic. If e serious, call 112.',
  languageSet: 'Okay, I go dey reply you for Pidgin. Tell me wetin dey do you or wetin you need.',
  option: 'Option',
  nearestOption: 'The one wey near pass',
  emergencyOption: 'Emergency',
  nearestEmergency: 'Emergency wey near pass',
  call: 'Call',
  noPhone: 'No phone number.',
  foundOnline: 'We see am online, we never check am. Call first make you sure say dem fit help.',
  foundOnlineShort: 'We see am online, we never check am.',
  fromDirectory: 'E dey HealthAccess list. Call first make you know if dem open.',
  aboutKm: (p) => `About ${p.km} km from you`,
  replyMore: 'Reply MORE for another one.',
  replyMoreEmergency: 'E serious? Call 112 now. Reply MORE for another one.',
  emergencyOnly: 'E serious? Call 112 now.',
  searchAgain: 'Send another area make I search again.',
  sourceNote: 'General info, no be diagnosis or doctor advice.',
  source: 'Source',
};

const yo: Dictionary = {
  help: 'HealthAccess le ran o lowo. Fesi pelu nomba: 1 Wa ile iwosan, 2 Iranlowo pajawiri, 3 Beere ibeere ilera, 4 Gba koodu mi. Tabi so ohun to n se o. Ninu ewu? Pe 112. Fesi LANG lati yi ede pada.',
  greeting:
    'E kaabo! HealthAccess ni. So ohun to n se o tabi ohun ti o nilo, bi "iba lati ana" tabi "ile iwosan ni Ikeja". Tabi fesi 1 Wa ile iwosan, 2 Pajawiri, 3 Beere ibeere, 4 Koodu mi.',
  urgent:
    'Eyi le je pajawiri. Wa iranlowo ni kiakia: pe 112 bayi tabi lo si ile iwosan pajawiri to sunmo. Fesi pelu agbegbe re (bi Ikeja), emi yoo fi ile iwosan pajawiri to sunmo ranse.',
  notLinked:
    'Foonu yii ko ti so po mo akanti HealthAccess. Wole si oju opo HealthAccess, si Channels ki o fi idi nomba yii mule, lehinna fesi CODE.',
  thanks: 'O se o. Fi ifiranse ranse nigbakugba ti o ba nilo itoju tabi ibeere ilera. Ninu ewu? Pe 112.',
  askArea: 'Agbegbe wo tabi ami-ile wo lo wa bayi?',
  askEmergencyArea: 'Agbegbe wo lo wa bayi? Ti o ba lewu pupo, pe 112 bayi.',
  savedAreaUrgent: (p) =>
    `Eyi le je pajawiri: pe 112 bayi tabi lo si ile iwosan pajawiri to sunmo. Mo n wa nitosi agbegbe re, ${p.area}. Fi EMERGENCY <agbegbe> ranse ti o ko ba si nibe.`,
  savedAreaEmergency: (p) =>
    `Mo n wa nitosi agbegbe re, ${p.area}. Ti o ba lewu, pe 112 bayi. Fi EMERGENCY <agbegbe> ranse ti o ba wa ni ibomiran.`,
  savedAreaCare: (p) => `Se ki n wa nitosi ${p.area} (agbegbe re)? Fesi YES, tabi fi agbegbe ti o wa bayi ranse.`,
  whichCare: (p) => `Itoju wo? ${p.options} Fesi pelu nomba. Lehinna maa beere agbegbe re.`,
  lastEmergency:
    'Iyen ni ibi pajawiri to kehin ti mo ri. Ti o ba lewu, pe 112 bayi. Lati wa ni ibomiran, fesi EMERGENCY ati agbegbe naa.',
  lastCare: 'Iyen ni eyi to kehin ti mo ri nitosi. Fi agbegbe miiran ranse ki n wa nibe.',
  noList: 'Ko si akojo kankan bayi. So itoju ti o nilo ati ibi, bi "ile iwosan ni Ikeja".',
  askQuestion: 'Kini o fe beere? So aisan tabi ibeere re ninu ifiranse kan.',
  myCode: (p) =>
    `Koodu pajawiri HealthAccess re ni ${p.code}. Enikeni ti o ba fun le ri alaye pajawiri re. Fesi NEW CODE fun koodu ti yoo pari ni wakati 1.`,
  myCodeEmpty: (p) =>
    `Koodu pajawiri HealthAccess re ni ${p.code}. Ko fi nkankan han sibe: yan akopo pajawiri re lori oju opo HealthAccess. Fesi NEW CODE fun koodu wakati 1.`,
  newCode: (p) =>
    `Koodu HealthAccess wakati 1 re ni ${p.code}. Fun dokita tabi noosi re. Yoo si alaye pajawiri re lori USSD tabi oju opo.`,
  nothingToShare: 'Ko alaye ilera re si oju opo HealthAccess ni akoko, lehinna fesi NEW CODE.',
  generalInfo: 'Alaye gbogbogbo ni eyi, kii se ayewo dokita.',
  tryAgain: 'Ma binu, mi o le dahun bayi. Jowo fi ifiranse re ranse lekan si ni iseju kan, tabi fesi HELP. Ninu ewu? Pe 112.',
  fallback: 'Mi o le fun o ni idahun to ni aabo lori SMS. Jowo ba osise ilera soro tabi lo si ile iwosan to sunmo. Ti o ba je pajawiri, pe 112.',
  languageSet: 'O dara, maa fesi ni ede Yoruba. So ohun to n se o tabi ohun ti o nilo.',
  option: 'Aayan',
  nearestOption: 'Eyi to sunmo julo',
  emergencyOption: 'Pajawiri',
  nearestEmergency: 'Pajawiri to sunmo julo',
  call: 'Pe',
  noPhone: 'Ko si nomba foonu.',
  foundOnline: 'A ri lori ayelujara, a ko tii se ayewo re. Pe won ni akoko lati mo boya won le ran o lowo.',
  foundOnlineShort: 'A ri lori ayelujara, a ko tii se ayewo re.',
  fromDirectory: 'Lati inu akojo HealthAccess. Pe won ni akoko lati mo boya won si si.',
  aboutKm: (p) => `Bi ${p.km} km si o`,
  replyMore: 'Fesi MORE fun omiran.',
  replyMoreEmergency: 'Se o lewu? Pe 112 bayi. Fesi MORE fun omiran.',
  emergencyOnly: 'Se o lewu? Pe 112 bayi.',
  searchAgain: 'Fi agbegbe miiran ranse lati wa lekan si.',
  sourceNote: 'Alaye gbogbogbo ni, kii se ayewo tabi imoran dokita.',
  source: 'Orisun',
};

const ha: Dictionary = {
  help: 'HealthAccess zai iya taimaka maka. Amsa da lamba: 1 Nemi asibiti, 2 Taimakon gaggawa, 3 Tambayar lafiya, 4 Samu lambar shiga ta. Ko ka fada mini abin da ke damunka. Kana cikin hadari? Kira 112. Amsa LANG don canza harshe.',
  greeting:
    'Sannu! Wannan HealthAccess ne. Fada mini abin da ke damunka ko abin da kake bukata, kamar "zazzabi tun jiya" ko "asibiti a Ikeja". Ko ka amsa 1 Nemi asibiti, 2 Gaggawa, 3 Yi tambaya, 4 Lambata.',
  urgent:
    'Wannan na iya zama gaggawa. Nemi taimako nan da nan: kira 112 yanzu ko je asibitin gaggawa mafi kusa. Amsa da unguwarka (kamar Ikeja) zan aiko maka asibitin gaggawa mafi kusa.',
  notLinked:
    'Wannan wayar ba a hada ta da asusun HealthAccess ba tukuna. Shiga shafin HealthAccess, bude Channels ka tabbatar da wannan lamba, sannan ka amsa CODE.',
  thanks: 'Babu komai. Aiko mini sako duk lokacin da kake bukatar kulawa ko tambayar lafiya. Kana cikin hadari? Kira 112.',
  askArea: 'A wace unguwa ko wane sanannen wuri kake yanzu?',
  askEmergencyArea: 'A wace unguwa kake yanzu? Idan yana da hadari sosai, kira 112 yanzu.',
  savedAreaUrgent: (p) =>
    `Wannan na iya zama gaggawa: kira 112 yanzu ko je asibitin gaggawa mafi kusa. Ina nema kusa da unguwarka, ${p.area}. Aika EMERGENCY <unguwa> idan ba ka can.`,
  savedAreaEmergency: (p) =>
    `Ina nema kusa da unguwarka, ${p.area}. Idan yana da hadari, kira 112 yanzu. Aika EMERGENCY <unguwa> idan kana wani wuri.`,
  savedAreaCare: (p) => `In nema kusa da ${p.area} (unguwarka)? Amsa YES, ko aiko unguwar da kake yanzu.`,
  whichCare: (p) => `Wace irin kulawa? ${p.options} Amsa da lamba. Sannan zan tambayi unguwarka.`,
  lastEmergency:
    'Wannan shi ne wurin gaggawa na karshe da na samu. Idan yana da hadari, kira 112 yanzu. Don nema a wani wuri, amsa EMERGENCY da unguwar.',
  lastCare: 'Wannan shi ne na karshe da na samu a kusa. Aiko wata unguwa in nema a can.',
  noList: 'Babu jerin sakamako yanzu. Fada mini irin kulawar da kake bukata da kuma inda, kamar "asibiti a Ikeja".',
  askQuestion: 'Me kake so ka tambaya? Bayyana ciwon ko tambayar a sako daya.',
  myCode: (p) =>
    `Lambar gaggawa ta HealthAccess taka ita ce ${p.code}. Duk wanda ka ba shi zai iya ganin bayanan gaggawarka. Amsa NEW CODE don lambar da za ta kare bayan awa 1.`,
  myCodeEmpty: (p) =>
    `Lambar gaggawa ta HealthAccess taka ita ce ${p.code}. Ba ta nuna komai ba tukuna: zabi takaitaccen bayanin gaggawarka a shafin HealthAccess. Amsa NEW CODE don lambar awa 1.`,
  newCode: (p) =>
    `Lambar HealthAccess ta awa 1 taka ita ce ${p.code}. Ba likita ko ma'aikaciyar jinya. Za ta bude bayanan gaggawarka ta USSD ko shafin yanar gizo.`,
  nothingToShare: 'Da farko ka saka bayanan lafiyarka a shafin HealthAccess, sannan ka amsa NEW CODE.',
  generalInfo: 'Wannan bayani ne na gaba daya, ba gano cuta ba ne.',
  tryAgain: 'Yi hakuri, ba zan iya amsawa yanzu ba. Don Allah sake aiko sakonka bayan minti daya, ko ka amsa HELP. Kana cikin hadari? Kira 112.',
  fallback: 'Ba zan iya ba da amsa mai aminci ta SMS ba. Don Allah ka yi magana da ma\'aikacin lafiya ko ka je asibiti mafi kusa. Idan gaggawa ce, kira 112.',
  languageSet: 'To, zan rika amsa maka da Hausa. Fada mini abin da ke damunka ko abin da kake bukata.',
  option: 'Zabi',
  nearestOption: 'Mafi kusa',
  emergencyOption: 'Gaggawa',
  nearestEmergency: 'Gaggawa mafi kusa',
  call: 'Kira',
  noPhone: 'Babu lambar waya.',
  foundOnline: 'An samo shi a intanet, ba mu tantance ba. Kira su da farko don tabbatar za su iya taimaka.',
  foundOnlineShort: 'An samo shi a intanet, ba mu tantance ba.',
  fromDirectory: 'Daga jerin HealthAccess. Kira da farko don sanin ko a bude suke.',
  aboutKm: (p) => `Kimanin ${p.km} km daga gare ka`,
  replyMore: 'Amsa MORE don wani.',
  replyMoreEmergency: 'Yana da hadari? Kira 112 yanzu. Amsa MORE don wani.',
  emergencyOnly: 'Yana da hadari? Kira 112 yanzu.',
  searchAgain: 'Aiko wata unguwa don sake nema.',
  sourceNote: 'Bayani na gaba daya ne, ba gano cuta ko shawarar likita ba.',
  source: 'Tushe',
};

const ig: Dictionary = {
  help: 'HealthAccess nwere ike inyere gi aka. Zaa na nomba: 1 Choo ulo ogwu, 2 Enyemaka mberede, 3 Juo ajuju ahuike, 4 Nweta koodu m. Ma o bu gwa m ihe na-eme gi. I no n\'ihe egwu? Kpoo 112. Zaa LANG iji gbanwee asusu.',
  greeting:
    'Ndewo! Nke a bu HealthAccess. Gwa m ihe na-eme gi ma o bu ihe i choro, dika "ahu oku kemgbe unyahu" ma o bu "ulo ogwu na Ikeja". Ma o bu zaa 1 Choo ulo ogwu, 2 Mberede, 3 Juo ajuju, 4 Koodu m.',
  urgent:
    'Nke a nwere ike ibu ihe mberede. Choo enyemaka ozigbo: kpoo 112 ugbu a ma o bu gaa ulo ogwu mberede kacha nso. Zaa na ebe i no (dika Ikeja), m ga-ezitere gi ulo ogwu mberede kacha nso.',
  notLinked:
    'Ejikotabeghi ekwenti a na akauntu HealthAccess. Banye na weebusaiti HealthAccess, mepee Channels ma kwado nomba a, wee zaa CODE ozo.',
  thanks: 'O di mma. Zitere m ozi mgbe obula i choro nlekota ma o bu nwee ajuju ahuike. I no n\'ihe egwu? Kpoo 112.',
  askArea: 'Ebee ka i no ugbu a, ma o bu ebe a ma ama di nso?',
  askEmergencyArea: 'Ebee ka i no ugbu a? O buru na o di egwu, kpoo 112 ugbu a.',
  savedAreaUrgent: (p) =>
    `Nke a nwere ike ibu ihe mberede: kpoo 112 ugbu a ma o bu gaa ulo ogwu mberede kacha nso. Ana m acho nso ebe i bi, ${p.area}. Ziga EMERGENCY <ebe> ma o buru na i noghi ebe ahu.`,
  savedAreaEmergency: (p) =>
    `Ana m acho nso ebe i bi, ${p.area}. O buru na o di egwu, kpoo 112 ugbu a. Ziga EMERGENCY <ebe> ma i no ebe ozo.`,
  savedAreaCare: (p) => `Ka m choo nso ${p.area} (ebe i bi)? Zaa YES, ma o bu ziga ebe i no ugbu a.`,
  whichCare: (p) => `Kedu nlekota? ${p.options} Zaa na nomba. M ga-ajuzi ebe i no.`,
  lastEmergency:
    'Nke ahu bu ebe mberede ikpeazu m hutara. O buru na o di egwu, kpoo 112 ugbu a. Iji choo ebe ozo, zaa EMERGENCY na aha ebe ahu.',
  lastCare: 'Nke ahu bu nke ikpeazu m hutara nso. Ziga ebe ozo ka m choo ebe ahu.',
  noList: 'Enweghi ndeputa ugbu a. Gwa m nlekota i choro na ebe, dika "ulo ogwu na Ikeja".',
  askQuestion: 'Gini ka i choro iju? Kowaa oria ma o bu ajuju gi n\'otu ozi.',
  myCode: (p) =>
    `Koodu mberede HealthAccess gi bu ${p.code}. Onye obula i nyere ya nwere ike ihu ozi mberede gi. Zaa NEW CODE maka koodu ga-agwu n'otu awa.`,
  myCodeEmpty: (p) =>
    `Koodu mberede HealthAccess gi bu ${p.code}. O naghi egosi ihe obula ugbu a: hoo nchikota mberede gi na weebusaiti HealthAccess. Zaa NEW CODE maka koodu otu awa.`,
  newCode: (p) =>
    `Koodu HealthAccess otu awa gi bu ${p.code}. Nye dokita ma o bu nosu gi. O ga-emeghe ozi mberede gi na USSD ma o bu weebusaiti.`,
  nothingToShare: 'Buru uzo tinye ozi ahuike gi na weebusaiti HealthAccess, wee zaa NEW CODE.',
  generalInfo: 'Nke a bu ozi izugbe, o bughi nchoputa oria.',
  tryAgain: 'Ndo, enweghi m ike iza ya ugbu a. Biko ziga ozi gi ozo mgbe nkeji ole na ole gachara, ma o bu zaa HELP. I no n\'ihe egwu? Kpoo 112.',
  fallback: 'Enweghi m ike inye aziza di mma site na SMS. Biko gwa onye oru ahuike okwu ma o bu gaa ulo ogwu kacha nso. O buru ihe mberede, kpoo 112.',
  languageSet: 'O di mma, m ga-aza gi n\'Igbo. Gwa m ihe na-eme gi ma o bu ihe i choro.',
  option: 'Nhoro',
  nearestOption: 'Nke kacha nso',
  emergencyOption: 'Mberede',
  nearestEmergency: 'Mberede kacha nso',
  call: 'Kpoo',
  noPhone: 'Enweghi nomba ekwenti.',
  foundOnline: 'Ahutara ya n\'intaneti, anyi enyochabeghi ya. Buru uzo kpoo ha iji jide n\'aka na ha nwere ike inye aka.',
  foundOnlineShort: 'Ahutara ya n\'intaneti, anyi enyochabeghi ya.',
  fromDirectory: 'Site na ndeputa HealthAccess. Kpoo ha tupu i gaa ka i mara ma ha meghere.',
  aboutKm: (p) => `Ihe dika ${p.km} km site n'ebe i no`,
  replyMore: 'Zaa MORE maka ozo.',
  replyMoreEmergency: 'O di egwu? Kpoo 112 ugbu a. Zaa MORE maka ozo.',
  emergencyOnly: 'O di egwu? Kpoo 112 ugbu a.',
  searchAgain: 'Ziga ebe ozo ka m choo ozo.',
  sourceNote: 'Ozi izugbe, o bughi nchoputa ma o bu ndumodu dokita.',
  source: 'Isi mmalite',
};

const dictionaries: Record<Locale, Dictionary> = { en, pcm, yo, ha, ig };

/** Translate a key; falls back to English when a language lacks the text. */
export function t(locale: Locale | null | undefined, key: string, params: Params = {}): string {
  const entry = dictionaries[locale ?? 'en']?.[key] ?? en[key];
  if (entry === undefined) throw new Error(`Missing translation key: ${key}`);
  return typeof entry === 'function' ? entry(params) : entry;
}

// ---------------- USSD (short, ASCII, within 182 characters) ----------------

const ussdText: Record<Locale, Record<string, string>> = {
  en: {
    main: 'HealthAccess\n1. Find care near me\n2. Open shared health info\n3. My access code\n4. Emergency help\n5. Language\n0. Exit',
    location: 'Enter area or landmark',
    emergencyLocation: 'Emergency help\nCall 112 now if life-threatening.\nEnter your area or landmark:',
    code: 'Enter the access code you were given',
    back: '0. Back',
    myArea: 'My area',
    invalid: 'Invalid choice.',
    language: 'Choose language\n1. English\n2. Pidgin\n3. Yoruba\n4. Hausa\n5. Igbo\n0. Back',
    chooseService: 'Choose service',
  },
  pcm: {
    main: 'HealthAccess\n1. Find clinic near me\n2. Open health info wey dem share\n3. My access code\n4. Emergency help\n5. Language\n0. Comot',
    location: 'Type your area or landmark',
    emergencyLocation: 'Emergency help\nIf e serious, call 112 now.\nType your area or landmark:',
    code: 'Type the access code wey dem give you',
    back: '0. Go back',
    myArea: 'My area',
    invalid: 'Wrong choice.',
    chooseService: 'Choose wetin you need',
  },
  yo: {
    main: 'HealthAccess\n1. Wa ile iwosan nitosi\n2. Si alaye ilera ti a pin\n3. Koodu mi\n4. Iranlowo pajawiri\n5. Ede\n0. Jade',
    location: 'Te agbegbe tabi ami-ile re',
    emergencyLocation: 'Iranlowo pajawiri\nTi o ba lewu, pe 112 bayi.\nTe agbegbe re:',
    code: 'Te koodu ti won fun o',
    back: '0. Pada',
    myArea: 'Agbegbe mi',
    invalid: 'Asise ni yiyan.',
    chooseService: 'Yan itoju',
  },
  ha: {
    main: 'HealthAccess\n1. Nemi asibiti kusa\n2. Bude bayanin lafiya\n3. Lambar shiga ta\n4. Taimakon gaggawa\n5. Harshe\n0. Fita',
    location: 'Rubuta unguwarka ko sanannen wuri',
    emergencyLocation: 'Taimakon gaggawa\nIdan yana da hadari, kira 112 yanzu.\nRubuta unguwarka:',
    code: 'Rubuta lambar da aka ba ka',
    back: '0. Koma',
    myArea: 'Unguwata',
    invalid: 'Zabi mara kyau.',
    chooseService: 'Zabi kulawa',
  },
  ig: {
    main: 'HealthAccess\n1. Choo ulo ogwu nso\n2. Mepee ozi ahuike\n3. Koodu m\n4. Enyemaka mberede\n5. Asusu\n0. Puo',
    location: 'Dee ebe i no ma o bu ebe a ma ama',
    emergencyLocation: 'Enyemaka mberede\nO buru na o di egwu, kpoo 112 ugbu a.\nDee ebe i no:',
    code: 'Dee koodu e nyere gi',
    back: '0. Laghachi',
    myArea: 'Ebe m',
    invalid: 'Nhoro ezighi ezi.',
    chooseService: 'Hoo nlekota',
  },
};

export function u(locale: Locale | null | undefined, key: string): string {
  return ussdText[locale ?? 'en']?.[key] ?? ussdText.en[key]!;
}

export const USSD_LANGUAGE_ORDER: Locale[] = ['en', 'pcm', 'yo', 'ha', 'ig'];
