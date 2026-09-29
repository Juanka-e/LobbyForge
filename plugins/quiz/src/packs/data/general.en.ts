import { q, type QuizPackQuestion } from '../types';

/**
 * General Knowledge — English. Stable facts only: no records, rankings or
 * "current" anything. The right answer's position is spread evenly over
 * A–D, so a game with shuffle off still has no pattern to learn.
 *
 * SERVER ONLY: the questions carry their answers. Imported by ../server.ts
 * (the `@lobbyforge/quiz/packs` entry), never by the panel or the plugin's
 * main entry — __tests__/client-bundle.test.ts holds that line.
 */
export const generalEnQuestions: readonly QuizPackQuestion[] = [
  q('gen-en-01', 'Who painted the Mona Lisa?', ['Michelangelo', 'Leonardo da Vinci', 'Raphael', 'Rembrandt'], 1),
  q('gen-en-02', 'How many players does each team start with on the pitch in a football (soccer) match?', ['9', '10', '11', '12'], 2),
  q('gen-en-03', 'Who wrote "Romeo and Juliet"?', ['William Shakespeare', 'Charles Dickens', 'Jane Austen', 'Mark Twain'], 0),
  q('gen-en-04', 'How many sides does a hexagon have?', ['3', '4', '5', '6'], 3),
  q('gen-en-05', 'In which sport would you see a "slam dunk"?', ['Volleyball', 'Tennis', 'Basketball', 'Handball'], 2),
  q('gen-en-06', 'How many strings does a standard violin have?', ['4', '5', '6', '7'], 0),
  q('gen-en-07', 'Which chess piece can only move diagonally?', ['Rook', 'Knight', 'King', 'Bishop'], 3),
  q('gen-en-08', 'How many minutes are there in a full day?', ['1,240', '1,440', '1,640', '2,400'], 1),
  q('gen-en-09', 'In Greek mythology, who is the king of the gods?', ['Zeus', 'Apollo', 'Hermes', 'Poseidon'], 0),
  q('gen-en-10', 'Which composer wrote the "Moonlight Sonata"?', ['Mozart', 'Bach', 'Beethoven', 'Chopin'], 2),
  q('gen-en-11', 'How many cards are in a standard deck, without jokers?', ['48', '52', '54', '56'], 1),
  q('gen-en-12', 'Who wrote "The Lord of the Rings"?', ['C. S. Lewis', 'George R. R. Martin', 'J. K. Rowling', 'J. R. R. Tolkien'], 3),
  q(
    'gen-en-13',
    'Which of the Seven Wonders of the Ancient World stood in Alexandria?',
    ['The Colossus', 'The Hanging Gardens', 'The Temple of Artemis', 'The Lighthouse'],
    3
  ),
  q('gen-en-14', 'What is the main ingredient of guacamole?', ['Avocado', 'Tomato', 'Pea', 'Cucumber'], 0),
  q('gen-en-15', 'Traditionally, how many colours are there in a rainbow?', ['5', '6', '7', '8'], 2),
  q('gen-en-16', 'Which instrument usually has 88 keys?', ['Organ', 'Piano', 'Harp', 'Accordion'], 1),
  q('gen-en-17', 'What do you call a word that reads the same backwards, like "level"?', ['Palindrome', 'Anagram', 'Acronym', 'Homonym'], 0),
  q('gen-en-18', 'Who wrote "Don Quixote"?', ['Lope de Vega', 'Gabriel García Márquez', 'Federico García Lorca', 'Miguel de Cervantes'], 3),
  q('gen-en-19', 'How many rings are on the Olympic flag?', ['4', '5', '6', '7'], 1),
  q('gen-en-20', 'What is the smallest prime number?', ['0', '1', '2', '3'], 2),
  q('gen-en-21', 'Which Roman numeral stands for 50?', ['V', 'X', 'L', 'C'], 2),
  q('gen-en-22', 'Which Shakespeare play contains the line "To be, or not to be"?', ['Macbeth', 'Hamlet', 'Othello', 'King Lear'], 1),
  q('gen-en-23', 'Which traditional wedding anniversary marks 50 years of marriage?', ['Silver', 'Pearl', 'Ruby', 'Golden'], 3),
  q('gen-en-24', 'Who was the first person to walk on the Moon?', ['Neil Armstrong', 'Buzz Aldrin', 'Yuri Gagarin', 'Michael Collins'], 0),
];
