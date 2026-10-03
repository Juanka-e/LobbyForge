import { describe, expect, it } from 'vitest';
import { userImagePath, userImageUrl } from '@/lib/user-image-url';

const USER = '00000000-0000-0000-0000-000000000001';

describe('userImageUrl — security-review FILE-001', () => {
  it('turns a version token into the same-origin image route', () => {
    expect(userImageUrl(USER, 'avatar', '0123456789ab')).toBe(`/api/users/${USER}/avatar?v=0123456789ab`);
    expect(userImageUrl(USER, 'banner', 'abcdefabcdef')).toBe(`/api/users/${USER}/banner?v=abcdefabcdef`);
  });

  it('returns null when there is no image', () => {
    expect(userImageUrl(USER, 'avatar', null)).toBeNull();
    expect(userImageUrl(USER, 'avatar', undefined)).toBeNull();
    expect(userImageUrl(USER, 'avatar', '')).toBeNull();
  });

  it('never passes a data URL through', () => {
    expect(userImageUrl(USER, 'avatar', 'data:image/png;base64,iVBORw0KGgo=')).toBeNull();
    expect(userImageUrl(USER, 'banner', 'data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
  });

  it('passes legacy https URLs through unchanged, and nothing else', () => {
    expect(userImageUrl(USER, 'avatar', 'https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(userImageUrl(USER, 'avatar', 'http://cdn.example.com/a.png')).toBeNull();
    expect(userImageUrl(USER, 'avatar', 'javascript:alert(1)')).toBeNull();
    expect(userImageUrl(USER, 'avatar', '//cdn.example.com/a.png')).toBeNull();
    // Could break out of CSS url(...) in the popover banner.
    expect(userImageUrl(USER, 'banner', 'https://x.example/a.png) , url(https://evil.example/b')).toBeNull();
    expect(userImageUrl(USER, 'avatar', `https://x.example/${'a'.repeat(2100)}`)).toBeNull();
  });

  it('rejects tokens that are not short lowercase hex', () => {
    expect(userImageUrl(USER, 'avatar', 'ABCDEF123456')).toBeNull();
    expect(userImageUrl(USER, 'avatar', '../../admin')).toBeNull();
  });

  it('encodes the path segments', () => {
    expect(userImagePath('a/b', 'avatar', 'abcdef')).toBe('/api/users/a%2Fb/avatar?v=abcdef');
  });
});
