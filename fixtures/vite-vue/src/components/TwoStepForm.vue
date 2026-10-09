<script setup>
import { ref } from 'vue'

const step = ref(1)
const name = ref('')
const done = ref(false)
</script>

<template>
  <form data-test="two-step-form" @submit.prevent>
    <template v-if="done">
      <p data-test="done">Submitted for {{ name }}</p>
    </template>
    <template v-else-if="step === 1">
      <h2>Step 1 of 2</h2>
      <label>Name <input v-model="name" data-test="name-input" /></label>
      <button data-test="next" @click="step = 2">Next</button>
    </template>
    <template v-else>
      <h2>Step 2 of 2</h2>
      <p data-test="summary">Review: {{ name }}</p>
      <button data-test="submit" @click="done = true">Submit</button>
    </template>
  </form>
</template>
