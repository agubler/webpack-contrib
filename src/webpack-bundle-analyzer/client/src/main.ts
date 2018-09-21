import global from '@dojo/framework/shim/global';
import ProjectorMixin from '@dojo/framework/widget-core/mixins/Projector';
import { App } from './App';

const Projector = ProjectorMixin(App);
const projector = new Projector();
projector.append(global.document.getElementById('app'));
