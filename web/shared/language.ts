export type Language = 'en' | 'pl';

const sportNames: Record<string, string> = {
  running: 'Bieg',
  run: 'Bieg',
  'road running': 'Bieg uliczny',
  'trail running': 'Bieg terenowy',
  'treadmill running': 'Bieg na bieżni',
  walking: 'Spacer',
  'nordic walking': 'Nordic walking',
  hiking: 'Wędrówka',
  trekking: 'Wędrówka',
  cycling: 'Rower',
  biking: 'Rower',
  'road cycling': 'Kolarstwo szosowe',
  'gravel cycling': 'Kolarstwo gravelowe',
  'indoor cycling': 'Rower stacjonarny',
  'mountain biking': 'Kolarstwo górskie',
  swimming: 'Pływanie',
  'pool swimming': 'Pływanie w basenie',
  'open water swimming': 'Pływanie w wodach otwartych',
  'weight training': 'Trening siłowy',
  'strength training': 'Trening siłowy',
  gym: 'Siłownia',
  'fitness class': 'Zajęcia fitness',
  fitness: 'Fitness',
  'cross training': 'Trening przekrojowy',
  'cross country skiing': 'Narciarstwo biegowe',
  skiing: 'Narciarstwo',
  'downhill skiing': 'Narciarstwo zjazdowe',
  skating: 'Łyżwiarstwo',
  rowing: 'Wioślarstwo',
  'indoor rowing': 'Ergometr wioślarski',
  climbing: 'Wspinaczka',
  triathlon: 'Triathlon',
  multisport: 'Wielobój',
  other: 'Inna aktywność',
  generic: 'Trening',
  unknown: 'Trening',
};

export const normalizeSport = (sport: string) => sport.toLowerCase().replace(/[_-]+/g, ' ').trim();
export function sportLabel(sport: string, language: Language = 'en') {
  const label = sport.trim();
  if (language === 'pl') return (sportNames[normalizeSport(label)] ?? label) || 'Trening';
  if (!label || ['generic', 'unknown'].includes(normalizeSport(label))) return 'Activity';
  return label[0].toUpperCase() + label.slice(1);
}
