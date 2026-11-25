// The skeleton the settings panels share: a list from one URL, one form that adds a new item or
// edits an existing one in place, and delete after a question. Built on attempt()/useAction().
import { ref, reactive } from 'vue';
import { get, post, patch, del, toast } from '../api.js';
import { attempt, useAction } from './useAction.js';

/**
 * base:    () => URL of the list. POST there adds an item; PATCH and DELETE go to `${base()}/${id}`.
 * list:    (response) => the array for `items`.
 * blank:   (item or null) => the form's values, for editing that item or for a new one.
 * body:    optional (isNew) => what to send on save (default: the form itself).
 * saved:   optional toast text after a save.
 * loaded:  optional async (response) => more to do after each successful load of the list.
 * changed: optional () => called after a save or a delete, once the list is reloaded.
 *
 * Returns { items, editing, form, busy, run, load, edit, save, remove }.
 * editing is null (form closed), 'new' or the id of the item in the form.
 * busy is true while save (or anything the panel passes to run) is running.
 */
export function useCrud({ base, list, blank, body, saved, loaded, changed }) {
  const items = ref([]);
  const editing = ref(null);
  const form = reactive({});
  const { busy, run } = useAction();

  async function load() {
    await attempt(async () => {
      const r = await get(base());
      items.value = list(r);
      if (loaded) await loaded(r);
    });
  }

  function edit(item) {
    editing.value = item ? item.id : 'new';
    Object.assign(form, blank(item));
  }

  function save() {
    return run(async () => {
      const isNew = editing.value === 'new';
      const data = body ? body(isNew) : form;
      if (isNew) await post(base(), data);
      else await patch(`${base()}/${editing.value}`, data);
      if (saved) toast(saved);
      editing.value = null;
      await load();
      if (changed) await changed();
    });
  }

  /** Delete after the question (skipped when empty). Resolves false when the person said no or it failed. */
  async function remove(item, question) {
    if (question && !confirm(question)) return false;
    return attempt(async () => {
      await del(`${base()}/${item.id}`);
      await load();
      if (changed) await changed();
    });
  }

  return { items, editing, form, busy, run, load, edit, save, remove };
}
