<template>
  <div class="shell" data-test="scroll-shell">
    <header class="shell-header">Sticky header</header>
    <main class="content" data-test="scroll-content">
      <slot />
    </main>
  </div>
</template>

<!-- Unscoped on purpose: like many real apps, the document itself never scrolls; this container does. -->
<style>
html,
body {
  height: 100%;
  margin: 0;
  overflow: hidden;
}
.shell {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.shell-header {
  position: sticky;
  top: 0;
  flex: none;
  height: 48px;
  line-height: 48px;
  padding: 0 16px;
  background: #1e3a8a;
  color: #fff;
}
.content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 16px;
}
</style>
