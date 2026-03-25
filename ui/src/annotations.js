import { Mark, mergeAttributes } from '@tiptap/core';

export const Annotation = Mark.create({
  name: 'annotation',

  addAttributes() {
    return {
      id: { default: null },
      comment: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'mark[data-annotation-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes({
      'data-annotation-id': HTMLAttributes.id,
      'data-comment': HTMLAttributes.comment,
      class: 'annotation-highlight',
      title: HTMLAttributes.comment,
    }), 0];
  },

  addCommands() {
    return {
      setAnnotation: (attrs) => ({ commands }) => {
        return commands.setMark(this.name, attrs);
      },
      removeAnnotation: (id) => ({ tr, state, dispatch }) => {
        if (!dispatch) return true;
        const { doc } = state;
        doc.descendants((node, pos) => {
          node.marks.forEach(mark => {
            if (mark.type.name === this.name && mark.attrs.id === id) {
              tr.removeMark(pos, pos + node.nodeSize, mark);
            }
          });
        });
        dispatch(tr);
        return true;
      },
    };
  },
});
