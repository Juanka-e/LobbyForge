import { q, type QuizPackQuestion } from '../types';

/**
 * Bilim ve Doğa — Türkçe. Stable facts only; answers spread evenly over
 * A–D.
 *
 * SERVER ONLY: the questions carry their answers. Imported by ../server.ts
 * (the `@lobbyforge/quiz/packs` entry), never by the panel or the plugin's
 * main entry — __tests__/client-bundle.test.ts holds that line.
 */
export const scienceTrQuestions: readonly QuizPackQuestion[] = [
  q('sci-tr-01', 'Altının kimyasal sembolü nedir?', ['Ag', 'Au', 'Al', 'Fe'], 1),
  q('sci-tr-02', 'Bitkiler fotosentez için havadan hangi gazı alır?', ['Oksijen', 'Azot', 'Karbondioksit', 'Hidrojen'], 2),
  q('sci-tr-03', '“Kızıl Gezegen” olarak bilinen gezegen hangisidir?', ['Mars', 'Venüs', 'Jüpiter', 'Merkür'], 0),
  q('sci-tr-04', 'Yetişkin bir insanın iskeletinde kaç kemik bulunur?', ['106', '156', '186', '206'], 3),
  q('sci-tr-05', 'Güneş Sistemi’nin en büyük gezegeni hangisidir?', ['Dünya', 'Satürn', 'Jüpiter', 'Neptün'], 2),
  q('sci-tr-06', 'Deniz seviyesinde su kaç derecede kaynar?', ['100 °C', '110 °C', '120 °C', '150 °C'], 0),
  q('sci-tr-07', 'Kanı vücuda pompalayan organ hangisidir?', ['Karaciğer', 'Akciğer', 'Böbrek', 'Kalp'], 3),
  q('sci-tr-08', 'Dünya’ya en yakın yıldız hangisidir?', ['Proxima Centauri', 'Güneş', 'Sirius', 'Kutup Yıldızı'], 1),
  q('sci-tr-09', 'Kurbağa yavrusuna ne ad verilir?', ['İribaş', 'Tırtıl', 'Pupa', 'Kurtçuk'], 0),
  q('sci-tr-10', 'Oksijeni vücuda taşıyan kan hücreleri hangileridir?', ['Akyuvarlar', 'Kan pulcukları', 'Alyuvarlar', 'Sinir hücreleri'], 2),
  q('sci-tr-11', 'Örümceklerin kaç bacağı vardır?', ['6', '8', '10', '12'], 1),
  q(
    'sci-tr-12',
    'Gezegenleri Güneş’in çevresindeki yörüngede tutan kuvvet hangisidir?',
    ['Manyetizma', 'Sürtünme', 'Elektrik', 'Kütle çekimi'],
    3
  ),
  q('sci-tr-13', 'Günümüzde yaşayan en büyük hayvan hangisidir?', ['Afrika fili', 'Zürafa', 'Kaşalot', 'Mavi balina'], 3),
  q('sci-tr-14', 'Görelilik kuramını geliştiren bilim insanı kimdir?', ['Albert Einstein', 'Isaac Newton', 'Niels Bohr', 'Galileo Galilei'], 0),
  q('sci-tr-15', 'Güneş Sistemi’nde kaç gezegen vardır?', ['6', '7', '8', '9'], 2),
  q('sci-tr-16', 'Işık boşlukta saniyede yaklaşık kaç kilometre yol alır?', ['30.000', '300.000', '3.000.000', '30.000.000'], 1),
  q('sci-tr-17', 'Elmas hangi elementten oluşur?', ['Karbon', 'Silisyum', 'Kalsiyum', 'Demir'], 0),
  q('sci-tr-18', 'Arılar bal yapmak için çiçeklerden ne toplar?', ['Polen', 'Reçine', 'Çiy', 'Nektar'], 3),
  q('sci-tr-19', 'Dünya atmosferinde en çok bulunan gaz hangisidir?', ['Oksijen', 'Azot', 'Karbondioksit', 'Argon'], 1),
  q('sci-tr-20', 'Yunuslar hangi hayvan grubundandır?', ['Balıklar', 'Sürüngenler', 'Memeliler', 'İki yaşamlılar'], 2),
  q('sci-tr-21', 'Saf suyun 25 °C’deki pH değeri kaçtır?', ['5', '6', '7', '8'], 2),
  q('sci-tr-22', 'Güneş ışığı alan derimiz hangi vitamini üretir?', ['A vitamini', 'D vitamini', 'C vitamini', 'K vitamini'], 1),
  q('sci-tr-23', 'İnsülin hormonunu hangi organ üretir?', ['Karaciğer', 'Mide', 'Böbrek', 'Pankreas'], 3),
  q('sci-tr-24', 'Ses hangisinin içinde en hızlı yayılır?', ['Çelik', 'Su', 'Hava', 'Boşluk'], 0),
];
