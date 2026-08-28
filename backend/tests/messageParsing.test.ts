import { parseFreeTextPosting } from '../src/services/messageParsing.service';

test('parses an FS message with reference and price', () => {
  const parsed = parseFreeTextPosting('FS Rolex Daytona 116500LN $18,500');
  expect(parsed).toEqual({
    postingType: 'FS',
    referenceNumber: '116500LN',
    askingPrice: 18500,
    maxBid: undefined,
    currency: 'USD',
  });
});

test('parses a WTB message with a "k" price shorthand', () => {
  const parsed = parseFreeTextPosting('WTB Daytona 116500LN budget 20k');
  expect(parsed?.postingType).toBe('WTB');
  expect(parsed?.maxBid).toBe(20000);
  expect(parsed?.askingPrice).toBeUndefined();
});

test('recognizes "looking for" as WTB', () => {
  const parsed = parseFreeTextPosting('Looking for a steel Datejust 36mm, any condition');
  expect(parsed?.postingType).toBe('WTB');
});

test('returns null for a message with no FS/WTB signal', () => {
  expect(parseFreeTextPosting('Anyone going to the watch fair this weekend?')).toBeNull();
});

test('returns null for an ambiguous message mentioning both FS and WTB', () => {
  expect(parseFreeTextPosting('FS this, WTB that')).toBeNull();
});

test('returns null for empty/whitespace input', () => {
  expect(parseFreeTextPosting('   ')).toBeNull();
});
