import { q, type QuizPackQuestion } from '../types';

/**
 * Genel Kültür — Türkçe. Written for Turkish players, not translated from
 * the English pack: Turkish literature, history and culture sit next to
 * the classics. Stable facts only; answers spread evenly over A–D.
 *
 * SERVER ONLY: the questions carry their answers. Imported by ../server.ts
 * (the `@lobbyforge/quiz/packs` entry), never by the panel or the plugin's
 * main entry — __tests__/client-bundle.test.ts holds that line.
 */
export const generalTrQuestions: readonly QuizPackQuestion[] = [
  q('gen-tr-01', 'İstiklal Marşı’nın şairi kimdir?', ['Namık Kemal', 'Mehmet Akif Ersoy', 'Ziya Gökalp', 'Tevfik Fikret'], 1),
  q('gen-tr-02', 'Türkiye Cumhuriyeti hangi yıl ilan edildi?', ['1920', '1921', '1923', '1924'], 2),
  q(
    'gen-tr-03',
    '“Çalıkuşu” romanının yazarı kimdir?',
    ['Reşat Nuri Güntekin', 'Halide Edib Adıvar', 'Yakup Kadri Karaosmanoğlu', 'Refik Halit Karay'],
    0
  ),
  q('gen-tr-04', 'Satranç tahtasında kaç kare vardır?', ['36', '48', '56', '64'], 3),
  q('gen-tr-05', 'Karagöz ile Hacivat hangi geleneksel sanatın karakterleridir?', ['Meddah', 'Orta oyunu', 'Gölge oyunu', 'Kukla'], 2),
  q('gen-tr-06', 'TBMM hangi tarihte açıldı?', ['23 Nisan 1920', '30 Ağustos 1922', '29 Ekim 1923', '3 Mart 1924'], 0),
  q('gen-tr-07', 'Satrançta yalnızca çapraz gidebilen taş hangisidir?', ['Kale', 'At', 'Şah', 'Fil'], 3),
  q(
    'gen-tr-08',
    'Mimar Sinan’ın “ustalık eserim” dediği cami hangisidir?',
    ['Süleymaniye Camii', 'Selimiye Camii', 'Şehzade Camii', 'Sultanahmet Camii'],
    1
  ),
  q(
    'gen-tr-09',
    'İstanbul’u 1453’te fetheden padişah kimdir?',
    ['Fatih Sultan Mehmet', 'Yavuz Sultan Selim', 'Kanuni Sultan Süleyman', 'II. Murat'],
    0
  ),
  q('gen-tr-10', '“Kuyucaklı Yusuf” romanını kim yazdı?', ['Orhan Kemal', 'Yaşar Kemal', 'Sabahattin Ali', 'Kemal Tahir'], 2),
  q('gen-tr-11', 'Tavla oynarken kaç zar kullanılır?', ['1', '2', '3', '4'], 1),
  q('gen-tr-12', 'Hangisi telli bir çalgıdır?', ['Ney', 'Kaval', 'Davul', 'Bağlama'], 3),
  q('gen-tr-13', 'Ünlü “Leyla ile Mecnun” mesnevisinin şairi kimdir?', ['Bâkî', 'Nedîm', 'Nef’î', 'Fuzûlî'], 3),
  q('gen-tr-14', 'Orhan Pamuk Nobel Edebiyat Ödülü’nü hangi yıl aldı?', ['2006', '2008', '2010', '2012'], 0),
  q('gen-tr-15', 'Türk alfabesinde kaç harf vardır?', ['26', '28', '29', '31'], 2),
  q('gen-tr-16', 'Nasreddin Hoca’nın türbesi hangi ilçededir?', ['Sivrihisar', 'Akşehir', 'Beypazarı', 'Safranbolu'], 1),
  q(
    'gen-tr-17',
    '“Nutuk”u kim kaleme almıştır?',
    ['Mustafa Kemal Atatürk', 'İsmet İnönü', 'Kâzım Karabekir', 'Fevzi Çakmak'],
    0
  ),
  q('gen-tr-18', 'Büyük Taarruz hangi yıl başladı?', ['1919', '1920', '1921', '1922'], 3),
  q('gen-tr-19', 'Olimpiyat bayrağında kaç halka vardır?', ['4', '5', '6', '7'], 1),
  q('gen-tr-20', 'Bir futbol maçının normal süresi kaç dakikadır?', ['70', '80', '90', '100'], 2),
  q('gen-tr-21', 'Roma rakamlarında 50 hangi harfle gösterilir?', ['V', 'X', 'L', 'C'], 2),
  q(
    'gen-tr-22',
    '“Beş Şehir” adlı deneme kitabının yazarı kimdir?',
    ['Yahya Kemal Beyatlı', 'Ahmet Hamdi Tanpınar', 'Peyami Safa', 'Cemal Süreya'],
    1
  ),
  q('gen-tr-23', 'Tersten okununca da aynı kalan “kek” gibi kelimelere ne denir?', ['Anagram', 'Akronim', 'Eş anlamlı', 'Palindrom'], 3),
  q('gen-tr-24', 'Yunan mitolojisinde tanrıların kralı kimdir?', ['Zeus', 'Apollon', 'Hermes', 'Poseidon'], 0),
];
