<script setup>
defineProps({ status: { type: String, required: true } })
</script>

<template>
  <span class="badge" :class="`badge-${status}`" data-test="status-badge">{{ status }}</span>
</template>

<style scoped>
.badge { padding: 2px 8px; border-radius: 8px; background: #eee; }
.badge-paid { background: #cfc; }
.badge-overdue { background: #fcc; }
</style>
