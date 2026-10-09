<script setup>
import { ref, onMounted } from 'vue'

const clubs = ref(null)
onMounted(async () => {
  clubs.value = await (await fetch('/api/clubs')).json()
})
</script>

<template>
  <main>
    <h1>Clubs</h1>
    <div v-if="!clubs" class="spinner">Loading...</div>
    <ul v-else data-test="club-list">
      <li v-for="club in clubs" :key="club.id">
        <router-link :to="`/manage/clubs/${club.id}/teams`">{{ club.name }}</router-link>
      </li>
    </ul>
  </main>
</template>
