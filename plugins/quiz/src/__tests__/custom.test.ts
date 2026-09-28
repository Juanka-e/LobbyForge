import { describe, expect, it } from 'vitest';
import { parseCustomQuestions } from '../custom';

const ok = (text: string) => {
  const result = parseCustomQuestions(text);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.questions;
};
const error = (text: string) => {
  const result = parseCustomQuestions(text);
  if (result.ok) throw new Error('expected an error');
  return result.error;
};

describe('parseCustomQuestions — the paste format', () => {
  it('reads blocks: question, answers, * marks the right one', () => {
    const questions = ok(`Which planet is closest to the Sun?
*Mercury
Venus
Mars

How many legs does a spider have?
6
* 8
10`);
    expect(questions).toEqual([
      { question: 'Which planet is closest to the Sun?', options: ['Mercury', 'Venus', 'Mars'], correctIndex: 0 },
      { question: 'How many legs does a spider have?', options: ['6', '8', '10'], correctIndex: 1 },
    ]);
  });

  it('tolerates numbering, "A)" labels, bullets, Windows line breaks and extra blank lines', () => {
    const questions = ok('1. Capital of Norway?\r\nA) Stockholm\r\n*B) Oslo\r\n- Helsinki\r\n\r\n\r\n\r\n2) Who wrote Hamlet?\n• Marlowe\n*Shakespeare');
    expect(questions[0]).toEqual({ question: 'Capital of Norway?', options: ['Stockholm', 'Oslo', 'Helsinki'], correctIndex: 1 });
    expect(questions[1]).toEqual({ question: 'Who wrote Hamlet?', options: ['Marlowe', 'Shakespeare'], correctIndex: 1 });
  });

  it('keeps initials and full stops inside answers', () => {
    const [question] = ok('Who wrote The Lord of the Rings?\nC. S. Lewis\n*J. R. R. Tolkien');
    expect(question!.options).toEqual(['C. S. Lewis', 'J. R. R. Tolkien']);
  });

  it('explains what is wrong, with the question number', () => {
    expect(error('   ')).toEqual({ code: 'empty' });
    expect(error('Q?\n*Only one')).toEqual({ code: 'tooFewOptions', question: 1 });
    expect(error('Q?\n*a\nb\n\nQ2?\na\nb')).toEqual({ code: 'noCorrect', question: 2 });
    expect(error('Q?\n*a\n*b')).toEqual({ code: 'manyCorrect', question: 1 });
    expect(error('Q?\n*a\nb\nc\nd\ne\nf\ng')).toEqual({ code: 'tooManyOptions', question: 1 });
    expect(error('Q?\n*Same\nsame')).toEqual({ code: 'duplicateOption', question: 1 });
    expect(error(`${'x'.repeat(301)}?\n*a\nb`)).toEqual({ code: 'tooLong', question: 1 });
    expect(error('*Mercury\nVenus')).toEqual({ code: 'noQuestion', question: 1 });
  });

  it('refuses more than 50 questions', () => {
    const block = 'Q?\n*a\nb';
    expect(error(Array.from({ length: 51 }, () => block).join('\n\n'))).toEqual({ code: 'tooMany' });
    expect(ok(Array.from({ length: 50 }, (_, i) => `Q${i}?\n*a\nb`).join('\n\n'))).toHaveLength(50);
  });

  it('still accepts the legacy JSON list', () => {
    const json = JSON.stringify([{ question: '2 + 2?', options: ['3', '4'], correctIndex: 1 }]);
    expect(ok(json)).toEqual([{ question: '2 + 2?', options: ['3', '4'], correctIndex: 1 }]);
    expect(error('[{"question": "x"}]')).toEqual({ code: 'invalidJson' });
    expect(error('[not json')).toEqual({ code: 'invalidJson' });
  });
});
