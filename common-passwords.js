// A short list of very common passwords (8+ characters, since shorter ones are already
// rejected), compared case-insensitively at signup. Not exhaustive; it just stops the worst picks.
export const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '12345678910', '0123456789', '87654321', '11111111',
  '00000000', '88888888', '12341234', '11223344', '123123123', '147258369', '987654321',
  '1q2w3e4r', '1q2w3e4r5t', '1qaz2wsx', 'zaq12wsx', 'qwertyui', 'qwertyuiop', 'asdfghjkl',
  'zxcvbnm1', 'asdf1234', 'qwer1234', 'abcd1234', 'abc12345', 'abcdefgh', 'aa123456',
  'password', 'password1', 'password12', 'password123', 'password!', 'passw0rd', 'p@ssw0rd',
  'p@ssword', 'iloveyou', 'iloveyou1', 'sunshine', 'princess', 'football', 'baseball',
  'basketball', 'welcome1', 'welcome123', 'superman', 'batman123', 'trustno1', 'starwars',
  'whatever', 'computer', 'michelle', 'jennifer', 'corvette', 'mercedes', 'liverpool',
  'chelsea1', 'arsenal1', 'letmein1', 'letmein123', 'changeme', 'changeme1', 'monkey123',
  'dragon123', 'master123', 'shadow123', 'qwerty123', 'qwerty12', 'qwerty1234', 'admin123',
  'administrator', 'login123', 'secret123', 'test1234', 'testing123', 'chirp123', 'chirpchirp',
]);
