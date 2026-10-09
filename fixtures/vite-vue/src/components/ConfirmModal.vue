<script setup>
defineEmits(['close', 'confirm'])
</script>

<template>
  <div class="overlay" data-test="confirm-modal">
    <div class="dialog" role="dialog" aria-modal="true">
      <h2>Confirm refund</h2>
      <p>This refunds the invoice in full.</p>
      <button data-test="modal-cancel" @click="$emit('close')">Cancel</button>
      <button data-test="modal-confirm" @click="$emit('confirm')">Refund</button>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); display: flex; align-items: center; justify-content: center; }
.dialog { background: #fff; padding: 24px 32px; border-radius: 8px; min-width: 320px; }
</style>
