<script setup>
import { ref, onMounted } from 'vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import TwoStepForm from '../components/TwoStepForm.vue'

const me = ref(null)
const modalOpen = ref(false)
onMounted(async () => {
  me.value = await (await fetch('/api/me')).json()
})
</script>

<template>
  <main data-test="interact">
    <h1>Interact</h1>
    <div v-if="!me" class="spinner">Loading...</div>
    <template v-else>
      <p data-test="whoami">Signed in as {{ me.email }}</p>
      <p v-if="me.role === 'finance'" data-test="finance-only">Finance dashboard: payouts</p>
      <button data-test="open-modal" @click="modalOpen = true">Refund</button>
      <TwoStepForm />
      <ConfirmModal v-if="modalOpen" @close="modalOpen = false" @confirm="modalOpen = false" />
    </template>
  </main>
</template>
