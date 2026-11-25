<script setup>
// Help: Security: two-factor sign-in and sessions
</script>
<template>
  <p>Everything here is under <RouterLink to="/profile" class="link">Profile</RouterLink>.</p>
  <ul class="list-disc space-y-1 pl-5">
    <li>
      <strong>Two-factor sign-in</strong>: after your password, sign-in also asks for a 6-digit code from an authenticator app on your phone
      (Google Authenticator, Microsoft Authenticator, 1Password and others). Choose Turn on, scan the QR code with the app (or type the
      key), and enter the code it shows.
    </li>
    <li>
      <strong>Recovery codes</strong>: you get 10 when you turn it on, shown once. Each signs you in one time when you do not have your
      phone. Keep them in a password manager. You can make new ones at any time; the old ones stop working.
    </li>
    <li>
      <strong>Lost your phone and the codes?</strong> Ask an admin to reset your two-factor sign-in. You then sign in with your password and
      set it up again.
    </li>
    <li>
      Turning it off needs a current code, a recovery code or your password. Ten wrong passwords or codes in 15 minutes lock sign-in for
      that account for 15 minutes.
    </li>
    <li><strong>Google sign-in</strong> is not asked for a code: Google does its own two-step verification.</li>
    <li>
      <strong>Sessions</strong> lists the browsers where you are signed in, with when each signed in and was last used. Sign out one, or
      everywhere else. Changing your password or turning two-factor off signs out your other sessions.
    </li>
    <li>Admins can set an idle timeout: a session nobody uses for that long is signed out. A session lasts 30 days at most.</li>
  </ul>
</template>
