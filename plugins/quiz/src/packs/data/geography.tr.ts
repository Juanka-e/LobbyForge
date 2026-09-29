import { q, type QuizPackQuestion } from '../types';

/**
 * Coğrafya — Türkçe. Starts at home (mountains, lakes, provinces) and then
 * travels. Stable facts only; answers spread evenly over A–D.
 *
 * SERVER ONLY: the questions carry their answers. Imported by ../server.ts
 * (the `@lobbyforge/quiz/packs` entry), never by the panel or the plugin's
 * main entry — __tests__/client-bundle.test.ts holds that line.
 */
export const geographyTrQuestions: readonly QuizPackQuestion[] = [
  q('geo-tr-01', 'Türkiye’nin en yüksek dağı hangisidir?', ['Erciyes Dağı', 'Ağrı Dağı', 'Süphan Dağı', 'Uludağ'], 1),
  q('geo-tr-02', 'Türkiye’nin en büyük gölü hangisidir?', ['Tuz Gölü', 'Beyşehir Gölü', 'Van Gölü', 'Eğirdir Gölü'], 2),
  q(
    'geo-tr-03',
    'İstanbul Boğazı hangi iki denizi birbirine bağlar?',
    ['Karadeniz ile Marmara', 'Ege ile Marmara', 'Akdeniz ile Ege', 'Karadeniz ile Ege'],
    0
  ),
  q('geo-tr-04', 'Pamukkale travertenleri hangi ildedir?', ['Muğla', 'Aydın', 'Antalya', 'Denizli'], 3),
  q('geo-tr-05', 'Türkiye kaç coğrafi bölgeye ayrılır?', ['5', '6', '7', '8'], 2),
  q('geo-tr-06', 'Yüzölçümü en büyük ilimiz hangisidir?', ['Konya', 'Ankara', 'Sivas', 'Erzurum'], 0),
  q(
    'geo-tr-07',
    'Kapadokya en çok hangi doğal oluşumlarıyla ünlüdür?',
    ['Travertenler', 'Buzul gölleri', 'Mercan resifleri', 'Peri bacaları'],
    3
  ),
  q(
    'geo-tr-08',
    'Tamamı Türkiye topraklarında bulunan en uzun akarsu hangisidir?',
    ['Sakarya', 'Kızılırmak', 'Yeşilırmak', 'Büyük Menderes'],
    1
  ),
  q('geo-tr-09', 'Türkiye’nin en doğu ucu hangi ildedir?', ['Iğdır', 'Kars', 'Ardahan', 'Van'], 0),
  q('geo-tr-10', 'Türkiye’nin en büyük adası hangisidir?', ['Bozcaada', 'Marmara Adası', 'Gökçeada', 'Cunda Adası'], 2),
  q('geo-tr-11', 'Efes Antik Kenti hangi ildedir?', ['Aydın', 'İzmir', 'Muğla', 'Manisa'], 1),
  q('geo-tr-12', 'Uludağ hangi ilimizdedir?', ['Balıkesir', 'Bilecik', 'Kütahya', 'Bursa'], 3),
  q('geo-tr-13', 'Tuz Gölü hangi coğrafi bölgededir?', ['Ege', 'Akdeniz', 'Doğu Anadolu', 'İç Anadolu'], 3),
  q('geo-tr-14', 'Avustralya’nın başkenti neresidir?', ['Kanberra', 'Sidney', 'Melbourne', 'Perth'], 0),
  q(
    'geo-tr-15',
    'Dünyanın en büyük okyanusu hangisidir?',
    ['Atlas Okyanusu', 'Hint Okyanusu', 'Büyük Okyanus (Pasifik)', 'Arktik Okyanusu'],
    2
  ),
  q('geo-tr-16', 'Yüzölçümü bakımından dünyanın en büyük ülkesi hangisidir?', ['Kanada', 'Rusya', 'Çin', 'ABD'], 1),
  q('geo-tr-17', 'Dünyanın en küçük ülkesi hangisidir?', ['Vatikan', 'Monako', 'San Marino', 'Lihtenştayn'], 0),
  q('geo-tr-18', 'Nil Nehri hangi denize dökülür?', ['Kızıldeniz', 'Arap Denizi', 'Ege Denizi', 'Akdeniz'], 3),
  q('geo-tr-19', 'Paris’in içinden geçen nehir hangisidir?', ['Ren', 'Sen', 'Tuna', 'Thames'], 1),
  q('geo-tr-20', 'Kilimanjaro Dağı hangi ülkededir?', ['Kenya', 'Uganda', 'Tanzanya', 'Etiyopya'], 2),
  q('geo-tr-21', 'Hangi ülkenin Karadeniz’e kıyısı yoktur?', ['Bulgaristan', 'Romanya', 'Macaristan', 'Gürcistan'], 2),
  q('geo-tr-22', 'Machu Picchu antik kenti hangi ülkededir?', ['Meksika', 'Peru', 'Bolivya', 'Şili'], 1),
  q('geo-tr-23', 'Ekvator çizgisi hangi kıtadan geçmez?', ['Afrika', 'Asya', 'Güney Amerika', 'Avrupa'], 3),
  q('geo-tr-24', 'Kanada’nın başkenti neresidir?', ['Ottava', 'Toronto', 'Vancouver', 'Montreal'], 0),
];
