import { q, type QuizPackQuestion } from '../types';

/**
 * Science & Nature — English. Stable facts only; answers spread evenly
 * over A–D.
 *
 * SERVER ONLY: the questions carry their answers. Imported by ../server.ts
 * (the `@lobbyforge/quiz/packs` entry), never by the panel or the plugin's
 * main entry — __tests__/client-bundle.test.ts holds that line.
 */
export const scienceEnQuestions: readonly QuizPackQuestion[] = [
  q('sci-en-01', 'What is the chemical symbol for gold?', ['Ag', 'Au', 'Gd', 'Ge'], 1),
  q('sci-en-02', 'Which gas do plants take in from the air for photosynthesis?', ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Hydrogen'], 2),
  q('sci-en-03', 'Which planet is known as the Red Planet?', ['Mars', 'Venus', 'Jupiter', 'Mercury'], 0),
  q('sci-en-04', 'How many bones are in the adult human body?', ['106', '156', '186', '206'], 3),
  q('sci-en-05', 'Which is the largest planet in our Solar System?', ['Earth', 'Saturn', 'Jupiter', 'Neptune'], 2),
  q('sci-en-06', 'At sea level, at what temperature does water boil?', ['100 °C', '110 °C', '120 °C', '150 °C'], 0),
  q('sci-en-07', 'Which organ pumps blood around the body?', ['Liver', 'Lungs', 'Kidneys', 'Heart'], 3),
  q('sci-en-08', 'What is the closest star to Earth?', ['Proxima Centauri', 'The Sun', 'Sirius', 'Polaris'], 1),
  q('sci-en-09', 'What is the hardest natural substance?', ['Diamond', 'Quartz', 'Granite', 'Iron'], 0),
  q('sci-en-10', 'Which blood cells carry oxygen around the body?', ['White blood cells', 'Platelets', 'Red blood cells', 'Nerve cells'], 2),
  q('sci-en-11', 'How many legs does a spider have?', ['6', '8', '10', '12'], 1),
  q('sci-en-12', 'Which force keeps the planets in orbit around the Sun?', ['Magnetism', 'Friction', 'Electricity', 'Gravity'], 3),
  q('sci-en-13', 'Which is the largest animal alive today?', ['African elephant', 'Giraffe', 'Sperm whale', 'Blue whale'], 3),
  q('sci-en-14', 'Which scientist developed the theory of general relativity?', ['Albert Einstein', 'Isaac Newton', 'Niels Bohr', 'Galileo Galilei'], 0),
  q('sci-en-15', 'How many planets are there in our Solar System?', ['6', '7', '8', '9'], 2),
  q('sci-en-16', 'Roughly how fast does light travel in a vacuum?', ['30,000 km/s', '300,000 km/s', '3,000,000 km/s', '30,000,000 km/s'], 1),
  q('sci-en-17', 'What is the chemical symbol for sodium?', ['Na', 'S', 'Sn', 'Sr'], 0),
  q('sci-en-18', 'What do bees collect from flowers to make honey?', ['Pollen', 'Sap', 'Dew', 'Nectar'], 3),
  q('sci-en-19', 'Which gas makes up most of Earth’s atmosphere?', ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Argon'], 1),
  q('sci-en-20', 'A tadpole grows up to become which animal?', ['Fish', 'Lizard', 'Frog', 'Snake'], 2),
  q('sci-en-21', 'What is the pH of pure water at 25 °C?', ['5', '6', '7', '8'], 2),
  q('sci-en-22', 'Which vitamin does your skin make when it is exposed to sunlight?', ['Vitamin A', 'Vitamin D', 'Vitamin C', 'Vitamin K'], 1),
  q('sci-en-23', 'Which organ produces insulin?', ['Liver', 'Stomach', 'Kidney', 'Pancreas'], 3),
  q('sci-en-24', 'Sound travels fastest through which of these?', ['Steel', 'Water', 'Air', 'A vacuum'], 0),
];
