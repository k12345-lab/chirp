import { app, h, newId, setTitle } from '../dom.js';
import { api } from '../api.js';
import { CONFIG } from '../config.js';
import { refreshMe, requestFocus, rerender, startView } from '../state.js';
import { asyncForm, privacyNotice } from '../components.js';

// The login form, or the sign-up form when `mode` is 'signup'.
export function renderAuth(mode = 'login') {
  startView();
  requestFocus(false); // The username field gets focus instead.
  const isLogin = mode === 'login';
  const usernameLengths = `${CONFIG.minUsernameLength}–${CONFIG.maxUsernameLength}`;
  setTitle(isLogin ? 'Log in' : 'Sign up');
  const error = h('p', { class: 'error', role: 'alert', id: newId('error') });

  const username = h('input', {
    name: 'username',
    autocomplete: 'username',
    autocapitalize: 'none',
    spellcheck: 'false',
    required: true,
    // Signup checks the rules up front; login accepts whatever an existing account has.
    ...(isLogin ? {} : {
      minlength: CONFIG.minUsernameLength,
      maxlength: CONFIG.maxUsernameLength,
      pattern: CONFIG.usernamePattern,
      title: `${usernameLengths} letters, numbers or underscores`,
    }),
  });
  const password = h('input', {
    name: 'password',
    type: 'password',
    autocomplete: isLogin ? 'current-password' : 'new-password',
    required: true,
    ...(isLogin ? {} : { minlength: CONFIG.minPasswordLength, maxlength: CONFIG.maxPasswordLength }),
  });

  // A labelled field with an optional hint; the hint and the form's error describe the input.
  const field = (label, input, hint, ...extra) => {
    input.id = newId('field');
    const hintEl = hint && h('p', { class: 'hint', id: newId('hint') }, hint);
    input.setAttribute('aria-describedby', [hintEl && hintEl.id, error.id].filter(Boolean).join(' '));
    // Mark the field invalid when the browser's own checks fail, until it's edited again.
    input.addEventListener('invalid', () => input.setAttribute('aria-invalid', 'true'));
    input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
    return h('div', { class: 'field' }, h('label', { for: input.id }, label), input, hintEl, ...extra);
  };

  const showPassword = h('input', {
    type: 'checkbox',
    onchange: () => { password.type = showPassword.checked ? 'text' : 'password'; },
  });
  const submit = h('button', { type: 'submit' }, isLogin ? 'Log in' : 'Create account');

  // Point out the field(s) a server error is about.
  const markInvalid = (message) => {
    const fields = /^invalid username or password/i.test(message) ? [username, password]
      : /^(that )?password/i.test(message) ? [password]
        : /^(that )?username/i.test(message) ? [username]
          : [];
    for (const input of fields) input.setAttribute('aria-invalid', 'true');
    fields[0]?.focus();
  };

  const form = asyncForm({}, {
    submit,
    error,
    onSubmit: async () => {
      try {
        await api('POST', isLogin ? '/api/login' : '/api/signup', {
          username: username.value,
          password: password.value,
        });
      } catch (err) {
        markInvalid(err.message);
        throw err;
      }
      await refreshMe();
      requestFocus();
      rerender(); // Keep the current hash, so a deep link like #/friends survives logging in.
    },
  },
  field('Username', username, !isLogin && `${usernameLengths} characters: letters, numbers and _`),
  field('Password', password, !isLogin && `At least ${CONFIG.minPasswordLength} characters.`,
    h('label', { class: 'checkbox' }, showPassword, 'Show password')),
  submit,
  error);
  showPassword.setAttribute('aria-controls', password.id);

  app.replaceChildren(h('div', { class: 'auth' },
    h('h1', {}, 'Chirp'),
    h('div', { class: 'card' },
      h('h2', {}, isLogin ? 'Log in' : 'Sign up'),
      form,
      !isLogin && privacyNotice(),
      h('p', { class: 'switch muted' },
        isLogin ? 'New here? ' : 'Already have an account? ',
        h('button', { class: 'link', type: 'button', onclick: () => renderAuth(isLogin ? 'signup' : 'login') },
          isLogin ? 'Create an account' : 'Log in'),
      ),
    ),
  ));
  username.focus();
}
