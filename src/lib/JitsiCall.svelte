<script lang="ts">
  import { onMount } from 'svelte';

  type JitsiApi = { dispose(): void };
  type JitsiApiConstructor = new (
    domain: string,
    options: {
      roomName: string;
      parentNode: HTMLElement;
      width: string;
      height: string;
      userInfo: { displayName: string };
      configOverwrite: Record<string, unknown>;
    }
  ) => JitsiApi;

  let { meetingUrl, displayName }: { meetingUrl: string; displayName: string } = $props();
  let host = $state<HTMLElement>();
  let error = $state('');

  onMount(() => {
    let disposed = false;
    let api: JitsiApi | undefined;
    const url = new URL(meetingUrl);
    const roomName = decodeURIComponent(url.pathname.replace(/^\/+/, ''));

    async function mountMeeting() {
      try {
        const scriptUrl = `${url.origin}/external_api.js`;
        let script = document.querySelector<HTMLScriptElement>(`script[src="${scriptUrl}"]`);
        if (!script) {
          script = document.createElement('script');
          script.src = scriptUrl;
          script.async = true;
          document.head.append(script);
        }
        if (!(window as Window & { JitsiMeetExternalAPI?: JitsiApiConstructor }).JitsiMeetExternalAPI) {
          await new Promise<void>((resolve, reject) => {
            script!.addEventListener('load', () => resolve(), { once: true });
            script!.addEventListener('error', () => reject(new Error('Jitsi could not be loaded')), { once: true });
          });
        }
        if (disposed || !host) return;
        const Constructor = (window as Window & { JitsiMeetExternalAPI?: JitsiApiConstructor }).JitsiMeetExternalAPI;
        if (!Constructor) throw new Error('Jitsi did not provide its embedding API');
        api = new Constructor(url.host, {
          roomName,
          parentNode: host,
          width: '100%',
          height: '100%',
          userInfo: { displayName },
          configOverwrite: { prejoinPageEnabled: true }
        });
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }

    void mountMeeting();
    return () => {
      disposed = true;
      api?.dispose();
    };
  });
</script>

{#if error}
  <div class="flex h-full items-center justify-center p-6 text-center text-sm text-error" role="alert">
    {error}. You can still open the meeting directly from the call controls.
  </div>
{:else}
  <div class="h-full min-h-0 w-full" bind:this={host}></div>
{/if}
