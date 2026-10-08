<script setup>
import { ref, onMounted } from 'vue'
import FlaggedDetails from '../components/FlaggedDetails.vue'

const flags = ref(null)
onMounted(async () => {
  flags.value = await (await fetch('/api/flags')).json()
})
</script>

<template>
  <main data-test="flagged">
    <h1>Flagged</h1>
    <div v-if="!flags" class="spinner">Loading...</div>
    <FlaggedDetails v-else-if="flags.showDetails" />
    <p v-else data-test="flagged-off">Details are switched off.</p>
  </main>
</template>
