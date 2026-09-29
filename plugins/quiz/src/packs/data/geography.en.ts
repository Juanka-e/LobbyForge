import { q, type QuizPackQuestion } from '../types';

/**
 * Geography — English. Stable facts only; answers spread evenly over A–D.
 *
 * SERVER ONLY: the questions carry their answers. Imported by ../server.ts
 * (the `@lobbyforge/quiz/packs` entry), never by the panel or the plugin's
 * main entry — __tests__/client-bundle.test.ts holds that line.
 */
export const geographyEnQuestions: readonly QuizPackQuestion[] = [
  q('geo-en-01', 'What is the capital of Australia?', ['Sydney', 'Canberra', 'Melbourne', 'Perth'], 1),
  q('geo-en-02', 'Which is the largest ocean on Earth?', ['Atlantic Ocean', 'Indian Ocean', 'Pacific Ocean', 'Arctic Ocean'], 2),
  q('geo-en-03', 'What is the capital of Canada?', ['Ottawa', 'Toronto', 'Vancouver', 'Montreal'], 0),
  q('geo-en-04', 'Mount Everest sits on the border between Nepal and which country?', ['India', 'Bhutan', 'Pakistan', 'China'], 3),
  q('geo-en-05', 'Which river flows through Paris?', ['Rhine', 'Thames', 'Seine', 'Danube'], 2),
  q('geo-en-06', 'Which is the smallest country in the world by area?', ['Vatican City', 'Monaco', 'San Marino', 'Liechtenstein'], 0),
  q('geo-en-07', 'On which continent is the Sahara Desert?', ['Asia', 'Australia', 'South America', 'Africa'], 3),
  q('geo-en-08', 'Which country has the largest land area?', ['Canada', 'Russia', 'China', 'United States'], 1),
  q('geo-en-09', 'The Andes mountain range runs through which continent?', ['South America', 'Africa', 'Asia', 'Europe'], 0),
  q('geo-en-10', 'What is the capital of Brazil?', ['Rio de Janeiro', 'São Paulo', 'Brasília', 'Salvador'], 2),
  q('geo-en-11', 'In which country is the ancient city of Machu Picchu?', ['Mexico', 'Peru', 'Bolivia', 'Chile'], 1),
  q(
    'geo-en-12',
    'Which strait separates Europe from Africa?',
    ['The Bosphorus', 'The Strait of Hormuz', 'The Dardanelles', 'The Strait of Gibraltar'],
    3
  ),
  q('geo-en-13', 'The Great Barrier Reef lies off the coast of which country?', ['New Zealand', 'Indonesia', 'Philippines', 'Australia'], 3),
  q('geo-en-14', 'What is the capital of Egypt?', ['Cairo', 'Alexandria', 'Luxor', 'Giza'], 0),
  q('geo-en-15', 'Which European country is shaped like a boot?', ['Greece', 'Spain', 'Italy', 'Portugal'], 2),
  q('geo-en-16', 'Which ocean lies between Africa and Australia?', ['Atlantic Ocean', 'Indian Ocean', 'Pacific Ocean', 'Southern Ocean'], 1),
  q('geo-en-17', 'Which US state is made up entirely of islands?', ['Hawaii', 'Alaska', 'Florida', 'Maine'], 0),
  q('geo-en-18', 'The Danube flows into which sea?', ['North Sea', 'Baltic Sea', 'Adriatic Sea', 'Black Sea'], 3),
  q('geo-en-19', 'What is the capital of Argentina?', ['Santiago', 'Buenos Aires', 'Lima', 'Montevideo'], 1),
  q('geo-en-20', 'In which country is Mount Kilimanjaro?', ['Kenya', 'Uganda', 'Tanzania', 'Ethiopia'], 2),
  q('geo-en-21', 'Which city lies on two continents, Europe and Asia?', ['Athens', 'Cairo', 'Istanbul', 'Moscow'], 2),
  q('geo-en-22', 'What is the capital of South Korea?', ['Busan', 'Seoul', 'Incheon', 'Daegu'], 1),
  q('geo-en-23', 'Which is the longest river in Europe?', ['Danube', 'Rhine', 'Dnieper', 'Volga'], 3),
  q('geo-en-24', 'What is the capital of Norway?', ['Oslo', 'Stockholm', 'Copenhagen', 'Helsinki'], 0),
];
