<template>
  <main data-test="login">
    <h1>Login</h1>
    <form @submit.prevent>
      <input type="email" placeholder="Email" />
      <button type="submit">Sign in</button>
    </form>
  </main>
</template>
