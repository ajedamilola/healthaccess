/** Basic Nigerian language support for the assistant screen (reviewed by native speakers before launch). */

export const ASSISTANT_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "pcm", label: "Pidgin" },
  { value: "yo", label: "Yoruba" },
  { value: "ha", label: "Hausa" },
  { value: "ig", label: "Igbo" },
] as const;

export type AssistantLocale = (typeof ASSISTANT_LANGUAGES)[number]["value"];

interface Copy {
  greeting: (name: string) => string;
  lead: string;
  suggestions: string[];
  placeholder: string;
  languageLabel: string;
  languageHint: string;
}

const copy: Record<AssistantLocale, Copy> = {
  en: {
    greeting: (name) => (name ? `Hi ${name}, how are you feeling?` : "How are you feeling today?"),
    lead: "Tell me what's going on in your own words. I'll ask a few questions if I need to and suggest what to do next. You can attach a photo or a PDF.",
    suggestions: [
      "I've had a fever and headache since yesterday",
      "My child has a cough and runny nose",
      "I feel dizzy when I stand up",
      "Is it safe to take paracetamol with my medicines?",
    ],
    placeholder: "Describe how you feel…",
    languageLabel: "Reply language",
    languageHint: "The assistant answers in this language for this conversation.",
  },
  pcm: {
    greeting: (name) => (name ? `How far ${name}, how your body dey?` : "How your body dey today?"),
    lead: "Tell me wetin dey do you for your own words. I fit ask you small questions, then I go tell you wetin to do next. You fit add photo or PDF.",
    suggestions: [
      "Fever and headache don catch me since yesterday",
      "My pikin dey cough and catarrh",
      "My head dey turn when I stand up",
      "I fit take paracetamol with my other medicine?",
    ],
    placeholder: "Tell me how your body dey…",
    languageLabel: "Language wey I go take reply",
    languageHint: "The assistant go answer you for dis language for dis chat.",
  },
  yo: {
    greeting: (name) => (name ? `E kaabo ${name}, bawo ni ara re?` : "Bawo ni ara re loni?"),
    lead: "So ohun to n se o ni ede ara re. Mo le beere ibeere die, lehinna maa so ohun ti o le se. O le so foto tabi PDF mo.",
    suggestions: [
      "Iba ati ori fifo lati ana",
      "Omo mi n wu iko, imu re si n san",
      "Oyi n kun mi ti mo ba dide",
      "Se mo le lo paracetamol pelu awon oogun mi?",
    ],
    placeholder: "So bi ara re se ri…",
    languageLabel: "Ede idahun",
    languageHint: "Oluranlowo yoo dahun ni ede yii fun ibaraenisoro yii.",
  },
  ha: {
    greeting: (name) => (name ? `Sannu ${name}, yaya jikinka?` : "Yaya jikinka yau?"),
    lead: "Fada mini abin da ke damunka da kalmominka. Zan iya yi maka 'yan tambayoyi, sannan in ba ka shawarar abin da za ka yi. Kana iya saka hoto ko PDF.",
    suggestions: [
      "Ina da zazzabi da ciwon kai tun jiya",
      "Yarona yana tari da mura",
      "Kaina yana juyawa idan na tashi tsaye",
      "Zan iya shan paracetamol tare da sauran magungunana?",
    ],
    placeholder: "Bayyana yadda kake ji…",
    languageLabel: "Harshen amsa",
    languageHint: "Mataimakin zai amsa da wannan harshe a wannan tattaunawa.",
  },
  ig: {
    greeting: (name) => (name ? `Ndewo ${name}, kedu ka ahu di gi?` : "Kedu ka ahu di gi taa?"),
    lead: "Gwa m ihe na-eme gi n'okwu nke gi. Enwere m ike iju gi ajuju ole na ole, wee gwa gi ihe i ga-eme. I nwere ike itinye foto ma o bu PDF.",
    suggestions: [
      "Ahu oku na isi owuwa kemgbe unyahu",
      "Nwa m na-ukwara, imi na-asoputa ya",
      "Isi na-agba m gburugburu mgbe m kwuliri",
      "Enwere m ike iji paracetamol na ogwu m ndi ozo?",
    ],
    placeholder: "Kowaa otu ahu di gi…",
    languageLabel: "Asusu nzaghachi",
    languageHint: "Onye enyemaka ga-aza n'asusu a maka mkparita uka a.",
  },
};

export function assistantLocale(value: string | null | undefined): AssistantLocale {
  const code = (value ?? "").toLowerCase().split(/[-_]/)[0];
  return (ASSISTANT_LANGUAGES.some((language) => language.value === code) ? code : "en") as AssistantLocale;
}

export function assistantCopy(value: string | null | undefined): Copy {
  return copy[assistantLocale(value)];
}
